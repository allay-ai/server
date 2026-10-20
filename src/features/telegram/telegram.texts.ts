import type { PlanId } from "../billing/plans";

type Texts = {
  /** The bot's profile: what an empty chat shows (≤ 512), the short line in its profile and in shares (≤ 120). */
  about: string;
  short_about: string;
  command_status: string;
  command_start: string;
  welcome: string;
  claimed: string;
  claim_failed: string;
  plans: string;
  plan: Record<PlanId, string>;
  plan_button: string;
  pay_button: string;
  invoice_title: Record<PlanId, string>;
  invoice_description: Record<PlanId, string>;
  invoice_ready: string;
  paid: string;
  renewed: string;
  status_none: string;
  status_title: string;
  status_active: string;
  status_inactive: string;
  status_quota: string;
  status_quota_spent: string;
  status_renews: string;
  stop_button: string;
  resume_button: string;
  renew_button: string;
  stopped: string;
  resumed: string;
  not_yours: string;
  unavailable: string;
  refunded: string;
  revoked: string;
  help: string;
};

const en: Texts = {
  about:
    "Allay is an AI helper for Minecraft servers: players ask in chat, and it answers with what it sees in the game.\n\nI take payments for it in Telegram Stars. Run /allay link on your server as an operator, open the link it shows, and pick a plan: a week, a month that renews by itself, or a year.",
  short_about: "Payments for Allay, the AI helper for Minecraft servers, in Telegram Stars.",
  command_status: "Your servers, their limits, and payment",
  command_start: "How to link a server",
  welcome:
    "Hi! I take payments for Allay, the AI helper for Minecraft servers.\n\nTo link a server, run /allay link on it as an operator and open the link it shows you.",
  claimed: "Server {server} is linked to your Telegram account.",
  claim_failed: "This link has expired or was already used. Run /allay link on the server again.",
  plans: "Pick a plan. A payment while a plan runs adds to it: the limit grows at once, and the end date moves.",
  plan: {
    week: "Week: 7 days, for a try or a small server",
    month: "Month: 30 days, renews by itself every month",
    year: "Year: 365 days, the limit refills every month",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pay {stars} ⭐",
  invoice_title: { week: "Allay for a week", month: "Allay for a month", year: "Allay for a year" },
  invoice_description: {
    week: "Allay answers your players' questions on server {server} for 7 days.",
    month: "Allay answers your players' questions on server {server}. Renews every 30 days; you can stop it any time.",
    year: "Allay answers your players' questions on server {server} for 365 days, with the limit refilled every month.",
  },
  invoice_ready: "Here's your invoice:",
  paid: "Thank you! Allay is active on server {server} until {date}.",
  renewed: "Your subscription renewed: Allay is active on server {server} until {date}.",
  status_none: "No servers are linked to this account yet. Run /allay link on your server as an operator.",
  status_title: "Your servers:",
  status_active: "{server}: active until {date}",
  status_inactive: "{server}: not paid",
  status_quota: "{percent}% of the limit used, refills {date}",
  status_quota_spent: "the limit is used up",
  status_renews: "renews by itself",
  stop_button: "Stop renewal",
  resume_button: "Resume renewal",
  renew_button: "Pay for {server}",
  stopped: "Renewal stopped. Allay stays active until {date}.",
  resumed: "Renewal is back on.",
  not_yours: "This server is linked to another Telegram account.",
  unavailable: "This plan can't be paid right now. Try again from /status.",
  refunded: "Refunded {stars} ⭐ for {server}.",
  revoked: "Your payments for {server} were refunded: {stars} ⭐ are back on your balance, and its Allay license is revoked. To use Allay there again, an operator deletes plugins/Allay/license.key and runs /allay link.",
  help: "/status: your servers, their limits, and buttons to pay\n/start: how to link a server",
};

const ru: Texts = {
  about:
    "Allay — ИИ-помощник для серверов Minecraft: игроки спрашивают в чате, а он отвечает, видя, что происходит в игре.\n\nЯ принимаю оплату за него звёздами Telegram. Выполните /allay link на своём сервере от имени оператора, откройте ссылку и выберите тариф: неделя, месяц с автопродлением или год.",
  short_about: "Оплата Allay, ИИ-помощника для серверов Minecraft, звёздами Telegram.",
  command_status: "Ваши серверы, их лимиты и оплата",
  command_start: "Как привязать сервер",
  welcome:
    "Привет! Я принимаю оплату за Allay — ИИ-помощника для серверов Minecraft.\n\nЧтобы привязать сервер, выполните на нём /allay link от имени оператора и откройте ссылку, которую он покажет.",
  claimed: "Сервер {server} привязан к вашему аккаунту Telegram.",
  claim_failed: "Ссылка устарела или уже использована. Выполните /allay link на сервере ещё раз.",
  plans: "Выберите тариф. Оплата во время действующего тарифа добавляется к нему: лимит растёт сразу, а срок сдвигается.",
  plan: {
    week: "Неделя — 7 дней, чтобы попробовать или для небольшого сервера",
    month: "Месяц — 30 дней, продлевается сам каждый месяц",
    year: "Год — 365 дней, лимит пополняется каждый месяц",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Оплатить {stars} ⭐",
  invoice_title: { week: "Allay на неделю", month: "Allay на месяц", year: "Allay на год" },
  invoice_description: {
    week: "Allay отвечает на вопросы игроков на сервере {server} 7 дней.",
    month: "Allay отвечает на вопросы игроков на сервере {server}. Продлевается каждые 30 дней, отключить можно в любой момент.",
    year: "Allay отвечает на вопросы игроков на сервере {server} 365 дней, лимит пополняется каждый месяц.",
  },
  invoice_ready: "Ваш счёт:",
  paid: "Спасибо! Allay работает на сервере {server} до {date}.",
  renewed: "Подписка продлена: Allay работает на сервере {server} до {date}.",
  status_none: "К этому аккаунту пока не привязан ни один сервер. Выполните /allay link на своём сервере от имени оператора.",
  status_title: "Ваши серверы:",
  status_active: "{server}: работает до {date}",
  status_inactive: "{server}: не оплачен",
  status_quota: "израсходовано {percent}% лимита, пополнение {date}",
  status_quota_spent: "лимит исчерпан",
  status_renews: "продлевается сам",
  stop_button: "Отключить продление",
  resume_button: "Включить продление",
  renew_button: "Оплатить {server}",
  stopped: "Продление отключено. Allay работает до {date}.",
  resumed: "Продление снова включено.",
  not_yours: "Этот сервер привязан к другому аккаунту Telegram.",
  unavailable: "Этот тариф сейчас нельзя оплатить. Попробуйте ещё раз из /status.",
  refunded: "Возвращено {stars} ⭐ за {server}.",
  revoked: "Платежи за {server} возвращены: {stars} ⭐ снова на вашем балансе, а лицензия Allay этого сервера аннулирована. Чтобы Allay снова работал там, оператор удаляет plugins/Allay/license.key и выполняет /allay link.",
  help: "/status — ваши серверы, их лимиты и кнопки оплаты\n/start — как привязать сервер",
};

const es: Texts = {
  about:
    "Allay es un asistente de IA para servidores de Minecraft: los jugadores preguntan en el chat y responde con lo que ve en el juego.\n\nAquí se paga en Telegram Stars. Ejecuta /allay link en tu servidor como operador, abre el enlace y elige un plan: una semana, un mes que se renueva solo o un año.",
  short_about: "Pagos de Allay, el asistente de IA para servidores de Minecraft, en Telegram Stars.",
  command_status: "Tus servidores, sus límites y el pago",
  command_start: "Cómo vincular un servidor",
  welcome:
    "¡Hola! Recibo los pagos de Allay, el asistente de IA para servidores de Minecraft.\n\nPara vincular un servidor, ejecuta /allay link en él como operador y abre el enlace que te muestre.",
  claimed: "El servidor {server} está vinculado a tu cuenta de Telegram.",
  claim_failed: "Este enlace caducó o ya se usó. Vuelve a ejecutar /allay link en el servidor.",
  plans: "Elige un plan. Si pagas mientras un plan sigue activo, se suma: el límite crece al momento y la fecha final se aplaza.",
  plan: {
    week: "Semana: 7 días, para probar o para un servidor pequeño",
    month: "Mes: 30 días, se renueva solo cada mes",
    year: "Año: 365 días, el límite se recarga cada mes",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pagar {stars} ⭐",
  invoice_title: { week: "Allay por una semana", month: "Allay por un mes", year: "Allay por un año" },
  invoice_description: {
    week: "Allay responde a las preguntas de tus jugadores en el servidor {server} durante 7 días.",
    month: "Allay responde a las preguntas de tus jugadores en el servidor {server}. Se renueva cada 30 días; puedes detenerlo cuando quieras.",
    year: "Allay responde a las preguntas de tus jugadores en el servidor {server} durante 365 días, con el límite recargado cada mes.",
  },
  invoice_ready: "Aquí tienes tu factura:",
  paid: "¡Gracias! Allay está activo en el servidor {server} hasta el {date}.",
  renewed: "Tu suscripción se renovó: Allay está activo en el servidor {server} hasta el {date}.",
  status_none: "Todavía no hay servidores vinculados a esta cuenta. Ejecuta /allay link en tu servidor como operador.",
  status_title: "Tus servidores:",
  status_active: "{server}: activo hasta el {date}",
  status_inactive: "{server}: sin pagar",
  status_quota: "{percent}% del límite usado, se recarga el {date}",
  status_quota_spent: "el límite está agotado",
  status_renews: "se renueva solo",
  stop_button: "Detener la renovación",
  resume_button: "Reanudar la renovación",
  renew_button: "Pagar {server}",
  stopped: "Renovación detenida. Allay sigue activo hasta el {date}.",
  resumed: "La renovación vuelve a estar activa.",
  not_yours: "Este servidor está vinculado a otra cuenta de Telegram.",
  unavailable: "Ahora no se puede pagar este plan. Inténtalo otra vez desde /status.",
  refunded: "Se devolvieron {stars} ⭐ por {server}.",
  revoked: "Te devolvimos los pagos de {server}: {stars} ⭐ vuelven a tu saldo y su licencia de Allay queda revocada. Para usar Allay allí otra vez, un operador borra plugins/Allay/license.key y ejecuta /allay link.",
  help: "/status: tus servidores, sus límites y botones para pagar\n/start: cómo vincular un servidor",
};

const pt: Texts = {
  about:
    "Allay é um assistente de IA para servidores de Minecraft: os jogadores perguntam no chat, e ele responde com o que vê no jogo.\n\nAqui você paga com Telegram Stars. Execute /allay link no seu servidor como operador, abra o link e escolha um plano: uma semana, um mês que renova sozinho ou um ano.",
  short_about: "Pagamentos do Allay, o assistente de IA para servidores de Minecraft, em Telegram Stars.",
  command_status: "Seus servidores, os limites e o pagamento",
  command_start: "Como vincular um servidor",
  welcome:
    "Olá! Eu recebo os pagamentos do Allay, o assistente de IA para servidores de Minecraft.\n\nPara vincular um servidor, execute /allay link nele como operador e abra o link que ele mostrar.",
  claimed: "O servidor {server} está vinculado à sua conta do Telegram.",
  claim_failed: "Este link expirou ou já foi usado. Execute /allay link no servidor de novo.",
  plans: "Escolha um plano. Um pagamento com um plano ainda ativo se soma a ele: o limite cresce na hora e a data final avança.",
  plan: {
    week: "Semana: 7 dias, para testar ou para um servidor pequeno",
    month: "Mês: 30 dias, renova sozinho todo mês",
    year: "Ano: 365 dias, o limite é recarregado todo mês",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pagar {stars} ⭐",
  invoice_title: { week: "Allay por uma semana", month: "Allay por um mês", year: "Allay por um ano" },
  invoice_description: {
    week: "O Allay responde às perguntas dos seus jogadores no servidor {server} por 7 dias.",
    month: "O Allay responde às perguntas dos seus jogadores no servidor {server}. Renova a cada 30 dias; você pode parar quando quiser.",
    year: "O Allay responde às perguntas dos seus jogadores no servidor {server} por 365 dias, com o limite recarregado todo mês.",
  },
  invoice_ready: "Aqui está a sua fatura:",
  paid: "Obrigado! O Allay está ativo no servidor {server} até {date}.",
  renewed: "Sua assinatura foi renovada: o Allay está ativo no servidor {server} até {date}.",
  status_none: "Ainda não há servidores vinculados a esta conta. Execute /allay link no seu servidor como operador.",
  status_title: "Seus servidores:",
  status_active: "{server}: ativo até {date}",
  status_inactive: "{server}: não pago",
  status_quota: "{percent}% do limite usado, recarrega em {date}",
  status_quota_spent: "o limite acabou",
  status_renews: "renova sozinho",
  stop_button: "Parar a renovação",
  resume_button: "Retomar a renovação",
  renew_button: "Pagar {server}",
  stopped: "Renovação parada. O Allay continua ativo até {date}.",
  resumed: "A renovação voltou a funcionar.",
  not_yours: "Este servidor está vinculado a outra conta do Telegram.",
  unavailable: "Não dá para pagar este plano agora. Tente de novo pelo /status.",
  refunded: "Foram devolvidas {stars} ⭐ por {server}.",
  revoked: "Os pagamentos de {server} foram devolvidos: {stars} ⭐ voltaram para o seu saldo, e a licença do Allay desse servidor foi revogada. Para usar o Allay lá de novo, um operador apaga plugins/Allay/license.key e executa /allay link.",
  help: "/status: seus servidores, os limites e botões para pagar\n/start: como vincular um servidor",
};

const de: Texts = {
  about:
    "Allay ist ein KI-Helfer für Minecraft-Server: Spieler fragen im Chat, und er antwortet mit dem, was er im Spiel sieht.\n\nHier bezahlst du ihn mit Telegram Stars. Führ /allay link als Operator auf deinem Server aus, öffne den Link und wähl einen Tarif: eine Woche, einen Monat, der sich selbst verlängert, oder ein Jahr.",
  short_about: "Zahlungen für Allay, den KI-Helfer für Minecraft-Server, in Telegram Stars.",
  command_status: "Deine Server, ihre Limits und Bezahlen",
  command_start: "Wie du einen Server verknüpfst",
  welcome:
    "Hi! Ich nehme Zahlungen für Allay an, den KI-Helfer für Minecraft-Server.\n\nUm einen Server zu verknüpfen, führ dort als Operator /allay link aus und öffne den Link, den er dir zeigt.",
  claimed: "Server {server} ist mit deinem Telegram-Konto verknüpft.",
  claim_failed: "Dieser Link ist abgelaufen oder wurde schon benutzt. Führ /allay link auf dem Server noch einmal aus.",
  plans: "Wähl einen Tarif. Zahlst du, während ein Tarif läuft, kommt er obendrauf: Das Limit wächst sofort, und das Enddatum rückt nach hinten.",
  plan: {
    week: "Woche: 7 Tage, zum Ausprobieren oder für einen kleinen Server",
    month: "Monat: 30 Tage, verlängert sich jeden Monat von selbst",
    year: "Jahr: 365 Tage, das Limit füllt sich jeden Monat neu auf",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "{stars} ⭐ bezahlen",
  invoice_title: { week: "Allay für eine Woche", month: "Allay für einen Monat", year: "Allay für ein Jahr" },
  invoice_description: {
    week: "Allay beantwortet 7 Tage lang die Fragen deiner Spieler auf Server {server}.",
    month: "Allay beantwortet die Fragen deiner Spieler auf Server {server}. Verlängert sich alle 30 Tage, du kannst es jederzeit stoppen.",
    year: "Allay beantwortet 365 Tage lang die Fragen deiner Spieler auf Server {server}, das Limit füllt sich jeden Monat neu auf.",
  },
  invoice_ready: "Hier ist deine Rechnung:",
  paid: "Danke! Allay läuft auf Server {server} bis zum {date}.",
  renewed: "Dein Abo wurde verlängert: Allay läuft auf Server {server} bis zum {date}.",
  status_none: "Mit diesem Konto ist noch kein Server verknüpft. Führ /allay link als Operator auf deinem Server aus.",
  status_title: "Deine Server:",
  status_active: "{server}: läuft bis zum {date}",
  status_inactive: "{server}: nicht bezahlt",
  status_quota: "{percent} % des Limits verbraucht, füllt sich am {date} auf",
  status_quota_spent: "das Limit ist aufgebraucht",
  status_renews: "verlängert sich von selbst",
  stop_button: "Verlängerung stoppen",
  resume_button: "Verlängerung fortsetzen",
  renew_button: "{server} bezahlen",
  stopped: "Verlängerung gestoppt. Allay läuft noch bis zum {date}.",
  resumed: "Die Verlängerung ist wieder an.",
  not_yours: "Dieser Server ist mit einem anderen Telegram-Konto verknüpft.",
  unavailable: "Dieser Tarif lässt sich gerade nicht bezahlen. Versuch es über /status noch einmal.",
  refunded: "{stars} ⭐ für {server} zurückerstattet.",
  revoked: "Deine Zahlungen für {server} sind zurückerstattet: {stars} ⭐ liegen wieder auf deinem Guthaben, und die Allay-Lizenz des Servers ist widerrufen. Damit Allay dort wieder läuft, löscht ein Operator plugins/Allay/license.key und führt /allay link aus.",
  help: "/status: deine Server, ihre Limits und Knöpfe zum Bezahlen\n/start: wie du einen Server verknüpfst",
};

const LANGUAGES: Record<string, Texts> = { en, ru, es, pt, de };

export const LANGUAGE_CODES = Object.keys(LANGUAGES);

export const PLAN_NAMES: Record<string, Record<PlanId, string>> = {
  en: { week: "Week", month: "Month", year: "Year" },
  ru: { week: "Неделя", month: "Месяц", year: "Год" },
  es: { week: "Semana", month: "Mes", year: "Año" },
  pt: { week: "Semana", month: "Mês", year: "Ano" },
  de: { week: "Woche", month: "Monat", year: "Jahr" },
};

/** Telegram's language code, cut to the languages the bot speaks; English otherwise. */
export const languageOf = (code?: string) => {
  const short = (code ?? "").slice(0, 2).toLowerCase();
  return short in LANGUAGES ? short : "en";
};

export const textsOf = (language: string): Texts => LANGUAGES[languageOf(language)];

export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

export const dateIn = (language: string, date: Date) =>
  new Intl.DateTimeFormat(languageOf(language), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
