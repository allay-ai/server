import { describe, expect, test } from "bun:test";
import { ChatText, toMinecraft } from "../src/agent/chat-text";

describe("Markdown in Minecraft answers", () => {
  test("bold and italics become & codes", () => {
    expect(toMinecraft("Depth Strider ставят на **ботинки**, а не на поножи.")).toBe("Depth Strider ставят на &lботинки&r, а не на поножи.");
    expect(toMinecraft("__Важно:__ не копай вниз")).toBe("&lВажно:&r не копай вниз");
    expect(toMinecraft("это *очень* редкий блок")).toBe("это &oочень&r редкий блок");
    expect(toMinecraft("это _очень_ редкий блок")).toBe("это &oочень&r редкий блок");
    expect(toMinecraft("***Осторожно***, крипер")).toBe("&l&oОсторожно&r, крипер");
    expect(toMinecraft("«**Незерит**» и (**алмазы**)")).toBe("«&lНезерит&r» и (&lалмазы&r)");
    expect(toMinecraft("**16** алмазов")).toBe("&l16&r алмазов");
  });

  test("a bold stretch keeps the color around it and inside it", () => {
    expect(toMinecraft("&eЗачаруй **ботинки** сначала&r")).toBe("&eЗачаруй &lботинки&r&e сначала&r");
    expect(toMinecraft("**&eботинки&r** готовы")).toBe("&e&lботинки&r&r готовы");
    expect(toMinecraft("&a**Готово:** *всё* в сундуке&r")).toBe("&a&lГотово:&r&a &oвсё&r&a в сундуке&r");
    // A style never reaches past its line.
    expect(toMinecraft("&eботинки\n**да**")).toBe("&eботинки\n&lда&r");
  });

  test("headings become bold lines, code loses its marks", () => {
    expect(toMinecraft("## Рецепт\nПоложи 3 шерсти")).toBe("&lРецепт&r\nПоложи 3 шерсти");
    expect(toMinecraft("# **Рецепт** #")).toBe("&lРецепт&r");
    expect(toMinecraft("Набери `/home` или `/spawn`")).toBe("Набери /home или /spawn");
    expect(toMinecraft("```\n/give @p diamond 1\n```\nГотово")).toBe("/give @p diamond 1\nГотово");
    expect(toMinecraft("`redbull:winter_apple` и `*.yml`")).toBe("redbull:winter_apple и *.yml");
  });

  test("stars and underscores that mean something else stay", () => {
    const kept = [
      "2*3*4 = 24",
      "2 * 3 * 4 = 24, а 5 * 6 = 30",
      "2**10 = 1024",
      "Права: allay.* и essentials.*",
      "Права: allay.*,mcmmo.*",
      "Файлы *.yml и *.json",
      "redbull:winter_apple и redbull:summer_pear",
      "minecraft:diamond_sword, minecraft:iron_ingot",
      "Игрок _Steve_ рядом, и __Alex__ тоже",
      "Ник Cool_Guy_42 и Dark__Knight",
      "/execute as @e[type=!player] run kill @s",
      "* пункт списка\n* ещё пункт",
      "Метка #1 и цвет #ff0000",
      "** не жирный **",
      "**без конца",
      "x = a*b + c*d",
      "сундук ~ ~ ~",
      "",
    ];
    for (const line of kept) expect(toMinecraft(line)).toBe(line);
  });

  test("button tags and links pass untouched", () => {
    const button = '<button action="ask" question="Что такое **Depth Strider**?">**Да**</button>';
    expect(toMinecraft(`Хочешь? ${button}`)).toBe(`Хочешь? ${button}`);
    expect(toMinecraft(`**Путь** <button action="command" command="/warp my_base_1">Домой</button> **сюда**`)).toBe(
      `&lПуть&r <button action="command" command="/warp my_base_1">Домой</button> &lсюда&r`,
    );
    expect(toMinecraft("Вики: https://minecraft.wiki/w/Depth_Strider_(enchantment) **тут**")).toBe(
      "Вики: https://minecraft.wiki/w/Depth_Strider_(enchantment) &lтут&r",
    );
    // Emphasis never reaches across a tag.
    expect(toMinecraft('**Да <button action="ask" question="x">Ок</button> нет**')).toBe('**Да <button action="ask" question="x">Ок</button> нет**');
  });

  test("text without Markdown comes back as it was", () => {
    const text = "&e-20 95 120&r — &6237&r блоков на юго-восток.\nВозьми &eкирку&r.";
    expect(toMinecraft(text)).toBe(text);
  });
});

describe("Markdown in a stream", () => {
  const samples = [
    "Depth Strider ставят на **ботинки**, а не на поножи.\n\nПоножи под него не подходят, зато **Swift Sneak** да.\n\n<button action=\"ask\" question=\"Какие зачарования?\">Зачарования</button> <button action=\"enchants\">Окно</button>",
    "## Рецепт\n```\n/give @p diamond\n```\n&eЗачаруй **ботинки** сначала&r и *всё*.\n2*3*4 и redbull:winter_apple",
    'Кнопка через строку <button action="ask" question="две\nстроки **x**">Да</button> **жирно**\nконец',
  ];

  const streamed = (text: string, cuts: number[]) => {
    const chat = new ChatText();
    let out = "";
    let at = 0;
    for (const cut of [...cuts, text.length]) {
      out += chat.push(text.slice(at, cut));
      at = cut;
    }
    return out + chat.flush();
  };

  test("pieces add up to the whole answer however the model splits it", () => {
    for (const text of samples) {
      const whole = toMinecraft(text);
      // Every single cut, then cuts every few characters, as a model's deltas come.
      for (let cut = 0; cut <= text.length; cut++) expect(streamed(text, [cut])).toBe(whole);
      for (const step of [1, 2, 3, 5, 7]) {
        const cuts = Array.from({ length: Math.floor(text.length / step) }, (_, i) => (i + 1) * step);
        expect(streamed(text, cuts)).toBe(whole);
      }
    }
  });

  test("a split ** waits for its line", () => {
    const chat = new ChatText();
    expect(chat.push("ставят на *")).toBe("");
    expect(chat.push("*ботинки*")).toBe("");
    expect(chat.push("*.\nдальше")).toBe("ставят на &lботинки&r.\n");
    expect(chat.flush()).toBe("дальше");
    expect(chat.flush()).toBe("");
  });

  test("a button tag open at a line end waits until it closes", () => {
    const chat = new ChatText();
    expect(chat.push('Да? <button action="ask" question="раз\n')).toBe("");
    expect(chat.push('два">Ок</button>\n')).toBe('Да? <button action="ask" question="раз\nдва">Ок</button>\n');
  });
});
