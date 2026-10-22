import { describe, expect, test } from "bun:test";
import { Settings, parseValue } from "../src/features/settings/settings";
import { DEFINITIONS } from "../src/features/settings/settings.definitions";
import { testVault } from "../src/infrastructure/settings/secrets";
import { memorySettings } from "../src/infrastructure/settings/store";

const fresh = (env: Record<string, string> = {}, store = memorySettings()) => new Settings(store, testVault(), env);

describe("settings", () => {
  test("the environment wins, then the stored value, then the default", async () => {
    const store = memorySettings();
    const stored = fresh({}, store);
    expect(stored.get("MAX_AGENT_STEPS")).toBe(26);
    expect(stored.source("MAX_AGENT_STEPS")).toBe("default");
    expect((await stored.update({ MAX_AGENT_STEPS: 12 }, 0, "owner")).ok).toBe(true);
    expect(stored.get("MAX_AGENT_STEPS")).toBe(12);
    expect(stored.source("MAX_AGENT_STEPS")).toBe("stored");

    const env = fresh({ MAX_AGENT_STEPS: "5" }, store);
    await env.reload();
    expect(env.get("MAX_AGENT_STEPS")).toBe(5);
    expect(env.source("MAX_AGENT_STEPS")).toBe("env");
  });

  test("an empty variable counts as unset, as compose passes ${X:-}", () => {
    const settings = fresh({ MAX_AGENT_STEPS: "", OPENROUTER_API_MODEL: " " });
    expect(settings.get("MAX_AGENT_STEPS")).toBe(26);
    expect(settings.get("OPENROUTER_API_MODEL")).toBe("~anthropic/claude-haiku-latest");
  });

  test("a field the environment sets can't change in the panel", async () => {
    const settings = fresh({ MAX_AGENT_STEPS: "5" });
    const result = await settings.update({ MAX_AGENT_STEPS: 9 }, 0, "owner");
    expect(result).toMatchObject({ ok: false, code: "LOCKED" });
    expect(settings.get("MAX_AGENT_STEPS")).toBe(5);
  });

  test("values are checked as the code needs them", async () => {
    const settings = fresh();
    expect(await settings.update({ MAX_AGENT_STEPS: 0 }, 0, "owner")).toMatchObject({ ok: false, code: "INVALID", errors: { MAX_AGENT_STEPS: "must be 1–50" } });
    expect(await settings.update({ OPENROUTER_API_MODEL: "perplexity/sonar" }, 0, "owner")).toMatchObject({ ok: false, errors: { OPENROUTER_API_MODEL: expect.any(String) } });
    expect(await settings.update({ CHAT_KEEP_TOKENS: 40_000 }, 0, "owner")).toMatchObject({ ok: false, errors: { CHAT_KEEP_TOKENS: expect.any(String) } });
    expect(await settings.update({ TELEGRAM_ADMIN_IDS: "12, abc" }, 0, "owner")).toMatchObject({ ok: false });
    expect(await settings.update({ NOT_A_SETTING: 1 }, 0, "owner")).toMatchObject({ ok: false, errors: { NOT_A_SETTING: "unknown setting" } });
    expect(settings.version).toBe(0);
  });

  test("null puts a field back to its default", async () => {
    const settings = fresh();
    await settings.update({ OPENROUTER_API_CTX: "high" }, 0, "owner");
    expect(settings.get("OPENROUTER_API_CTX")).toBe("high");
    await settings.update({ OPENROUTER_API_CTX: null }, 1, "owner");
    expect(settings.get("OPENROUTER_API_CTX")).toBe("medium");
  });

  test("a save from an old version is refused", async () => {
    const settings = fresh();
    await settings.update({ MAX_AGENT_STEPS: 9 }, 0, "a");
    expect(await settings.update({ MAX_AGENT_STEPS: 10 }, 0, "b")).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  test("secrets are sealed at rest and never shown back", async () => {
    const store = memorySettings();
    const settings = fresh({}, store);
    const result = await settings.update({ OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef" }, 0, "owner");
    expect(result).toMatchObject({ ok: true, changes: [{ key: "OPENROUTER_API_KEY", old: "unset", new: "set …cdef" }] });
    expect(settings.get("OPENROUTER_API_KEY")).toBe("sk-or-v1-0123456789abcdef");

    const raw = JSON.stringify(await store.load());
    expect(raw).not.toContain("0123456789abcdef");
    const field = settings.view().fields.find((f) => f.key === "OPENROUTER_API_KEY")!;
    expect(JSON.stringify(field)).not.toContain("0123456789");
    expect(field).toMatchObject({ secret: { set: true, last4: "cdef", broken: false } });

    // Another key can't open it: the field reads as unset and says why.
    const other = new Settings(store, testVault("another key"), {});
    await other.reload();
    expect(other.get("OPENROUTER_API_KEY")).toBeUndefined();
    expect(other.view().fields.find((f) => f.key === "OPENROUTER_API_KEY")).toMatchObject({ secret: { set: false, broken: true } });
  });

  test("importing copies the environment into the store", async () => {
    const store = memorySettings();
    const settings = fresh({ OPENROUTER_API_KEY: "sk-or-v1-from-the-env-1234", MAX_AGENT_STEPS: "6", PLAN_STARS: "week=1,year=3" }, store);
    const result = await settings.importEnv("owner");
    expect(result.ok).toBe(true);
    const later = fresh({}, store);
    await later.reload();
    expect(later.get("OPENROUTER_API_KEY")).toBe("sk-or-v1-from-the-env-1234");
    expect(later.get("MAX_AGENT_STEPS")).toBe(6);
    expect(later.get("PLAN_WEEK_STARS")).toBe(1);
    expect(later.get("PLAN_MONTH_STARS")).toBe(500);
    expect(later.get("PLAN_YEAR_STARS")).toBe(3);
  });

  test("a default can follow another setting", async () => {
    const settings = fresh({ API_URL: "https://allay.example/" });
    expect(settings.get("PUBLIC_URL")).toBe("https://allay.example");
    await settings.update({ PUBLIC_URL: "https://mc.example/allay" }, 0, "owner");
    expect(settings.get("PUBLIC_URL")).toBe("https://mc.example/allay");
  });

  test("listeners hear which keys changed", async () => {
    const settings = fresh();
    const heard: string[][] = [];
    settings.onChange((keys) => heard.push(keys));
    await settings.update({ MAX_AGENT_STEPS: 9 }, 0, "owner");
    await settings.update({ MAX_AGENT_STEPS: 9, MAX_TASK_STEPS: 20 }, 1, "owner");
    expect(heard).toEqual([["MAX_AGENT_STEPS"], ["MAX_TASK_STEPS"]]);
  });

  test("parsing follows each type", () => {
    expect(parseValue(DEFINITIONS.TELEGRAM_POLLING, "1")).toEqual({ ok: true, value: true });
    expect(parseValue(DEFINITIONS.TELEGRAM_POLLING, "no")).toEqual({ ok: true, value: false });
    expect(parseValue(DEFINITIONS.TRACE_SAMPLE, "0.25")).toEqual({ ok: true, value: 0.25 });
    expect(parseValue(DEFINITIONS.MAX_AGENT_STEPS, "2.5")).toMatchObject({ ok: false });
    expect(parseValue(DEFINITIONS.API_URL, "ftp://x")).toMatchObject({ ok: false });
    expect(parseValue(DEFINITIONS.OPENROUTER_API_CTX, "huge")).toMatchObject({ ok: false });
  });
});
