import type { PlanId } from "../billing/plans";

type Texts = {
  /** The bot's profile: what an empty chat shows (≤ 512), the short line in its profile and in shares (≤ 120). */
  about: string;
  short_about: string;
  command_status: string;
  command_start: string;
  /** The onboarding: what Allay is and the three steps to a linked server; /start, and any message from an account without one. */
  welcome: string;
  download_button: string;
  guide_button: string;
  servers_button: string;
  howto_button: string;
  back_button: string;
  /** Any other message from an account with servers. */
  chatter: string;
  claimed: string;
  claim_failed: string;
  plans: string;
  /** Under the plans when SUPPORT_CONTACT is set. */
  more: string;
  plan: Record<PlanId, string>;
  plan_button: string;
  pay_button: string;
  invoice_title: Record<PlanId, string>;
  invoice_description: Record<PlanId, string>;
  invoice_ready: string;
  paid: string;
  renewed: string;
  status_title: string;
  status_active: string;
  status_inactive: string;
  status_quota: string;
  status_quota_spent: string;
  status_renews: string;
  /** A Solo license's line: one player has it, or the first who asks takes it. */
  status_solo_bound: string;
  status_solo_free: string;
  release_button: string;
  released: string;
  /** When SOLO_RELEASE_DAYS haven't passed since the last hand-over. */
  release_wait: string;
  stop_button: string;
  resume_button: string;
  renew_button: string;
  stopped: string;
  resumed: string;
  not_yours: string;
  unavailable: string;
  refunded: string;
  revoked: string;
};

const en: Texts = {
  about:
    "Allay is an AI helper for Minecraft servers: players ask in chat, and it answers with what it sees in the game.\n\nI take payments for it in Telegram Stars. Run /allay link on your server as an operator, or in your own world with the mod, open the link it shows, and pick a plan: a week, a month that renews by itself, or a year.",
  short_about: "Payments for Allay, the AI helper for Minecraft servers, in Telegram Stars.",
  command_status: "Your servers, their limits, and payment",
  command_start: "How to link a server",
  welcome:
    "👋 Hi! Here you pay for Allay, the AI helper for Minecraft, with Telegram Stars.\n\nHow to start:\n1️⃣ Install Allay: the plugin on Paper or Spigot, or the mod on Fabric or NeoForge.\n2️⃣ In the game, run /allay link: as an operator, or in your own world.\n3️⃣ Tap the link Allay shows. It brings you back here: pick a plan, pay, and Allay answers right away.\n\n🔑 With your own AI key, Allay costs nothing here.",
  download_button: "📥 Download Allay",
  guide_button: "📖 Setup guide",
  servers_button: "📋 My servers",
  howto_button: "➕ Link another server",
  back_button: "⬅️ All servers",
  chatter: "🤖 I handle payments and servers here. To ask Allay something, write /ask in the game.",
  claimed: "Server {server} is linked to your Telegram account.",
  claim_failed: "This link has expired or was already used. Run /allay link on the server again.",
  plans: "Pick a plan. A payment while a plan runs adds to it: the limit grows at once, and the end date moves.",
  more: "Need more than a year gives? Contact us: {contact}",
  plan: {
    week: "Week: 7 days, for a try or a small server",
    month: "Month: 30 days, renews by itself every month",
    year: "Year: 365 days, the limit refills every month",
    solo_week: "Solo week: 7 days for you alone, in your own game",
    solo_month: "Solo month: 30 days for you alone, renews by itself every month",
    solo_year: "Solo year: 365 days for you alone, the limit refills every month",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pay {stars} ⭐",
  invoice_title: { week: "Allay for a week", month: "Allay for a month", year: "Allay for a year", solo_week: "Allay Solo for a week", solo_month: "Allay Solo for a month", solo_year: "Allay Solo for a year" },
  invoice_description: {
    week: "Allay answers your players' questions on server {server} for 7 days.",
    month: "Allay answers your players' questions on server {server}. Renews every 30 days; you can stop it any time.",
    year: "Allay answers your players' questions on server {server} for 365 days, with the limit refilled every month.",
    solo_week: "Allay answers your own questions in your game for 7 days.",
    solo_month: "Allay answers your own questions in your game. Renews every 30 days; you can stop it any time.",
    solo_year: "Allay answers your own questions in your game for 365 days, with the limit refilled every month.",
  },
  invoice_ready: "Here's your invoice:",
  paid: "Thank you! Allay is active on server {server} until {date}.",
  renewed: "Your subscription renewed: Allay is active on server {server} until {date}.",
  status_title: "📋 Your servers. Tap one for details:",
  status_active: "Active until {date}",
  status_inactive: "Not paid",
  status_quota: "{percent}% of the limit used, refills {date}",
  status_quota_spent: "The limit is used up",
  status_renews: "Renews by itself",
  status_solo_bound: "Solo: answers one player, who has it now",
  status_solo_free: "Solo: the first player who asks takes it",
  release_button: "🔄 Hand to another player",
  released: "Done: the next player who asks on {server} takes it.",
  release_wait: "You can hand it to another player again on {date}.",
  stop_button: "Stop renewal",
  resume_button: "Resume renewal",
  renew_button: "💳 Pay or extend",
  stopped: "Renewal stopped. Allay stays active until {date}.",
  resumed: "Renewal is back on.",
  not_yours: "This server is linked to another Telegram account.",
  unavailable: "This plan can't be paid right now. Try again from /status.",
  refunded: "Refunded {stars} ⭐ for {server}.",
  revoked: "Your payments for {server} were refunded: {stars} ⭐ are back on your balance, and its Allay license is revoked. To use Allay there again, an operator deletes plugins/Allay/license.key and runs /allay link.",

};

const ru: Texts = {
  about:
    "Allay — ИИ-помощник для серверов Minecraft: игроки спрашивают в чате, а он отвечает, видя, что происходит в игре.\n\nЯ принимаю оплату за него звёздами Telegram. Выполните /allay link на своём сервере от имени оператора или в своём мире с модом, откройте ссылку и выберите тариф: неделя, месяц с автопродлением или год.",
  short_about: "Оплата Allay, ИИ-помощника для серверов Minecraft, звёздами Telegram.",
  command_status: "Ваши серверы, их лимиты и оплата",
  command_start: "Как привязать сервер",
  welcome:
    "👋 Привет! Здесь оплачивают Allay — ИИ-помощника для Minecraft — звёздами Telegram.\n\nКак начать:\n1️⃣ Установите Allay: плагин на Paper или Spigot либо мод на Fabric или NeoForge.\n2️⃣ В игре выполните /allay link — от имени оператора или в своём мире.\n3️⃣ Нажмите на ссылку, которую покажет Allay. Она вернёт вас сюда: выберите тариф, оплатите, и Allay сразу начнёт отвечать.\n\n🔑 Со своим ключом ИИ Allay здесь бесплатен.",
  download_button: "📥 Скачать Allay",
  guide_button: "📖 Инструкция",
  servers_button: "📋 Мои серверы",
  howto_button: "➕ Привязать ещё сервер",
  back_button: "⬅️ Все серверы",
  chatter: "🤖 Здесь я занимаюсь оплатой и серверами. Чтобы спросить Allay, напишите /ask в игре.",
  claimed: "Сервер {server} привязан к вашему аккаунту Telegram.",
  claim_failed: "Ссылка устарела или уже использована. Выполните /allay link на сервере ещё раз.",
  plans: "Выберите тариф. Оплата во время действующего тарифа добавляется к нему: лимит растёт сразу, а срок сдвигается.",
  more: "Нужно больше, чем даёт год? Напишите нам: {contact}",
  plan: {
    week: "Неделя — 7 дней, чтобы попробовать или для небольшого сервера",
    month: "Месяц — 30 дней, продлевается сам каждый месяц",
    year: "Год — 365 дней, лимит пополняется каждый месяц",
    solo_week: "Solo-неделя — 7 дней только для вас, в вашей собственной игре",
    solo_month: "Solo-месяц — 30 дней только для вас, продлевается сам каждый месяц",
    solo_year: "Solo-год — 365 дней только для вас, лимит пополняется каждый месяц",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Оплатить {stars} ⭐",
  invoice_title: { week: "Allay на неделю", month: "Allay на месяц", year: "Allay на год", solo_week: "Allay Solo на неделю", solo_month: "Allay Solo на месяц", solo_year: "Allay Solo на год" },
  invoice_description: {
    week: "Allay отвечает на вопросы игроков на сервере {server} 7 дней.",
    month: "Allay отвечает на вопросы игроков на сервере {server}. Продлевается каждые 30 дней, отключить можно в любой момент.",
    year: "Allay отвечает на вопросы игроков на сервере {server} 365 дней, лимит пополняется каждый месяц.",
    solo_week: "Allay отвечает на ваши вопросы в вашей игре 7 дней.",
    solo_month: "Allay отвечает на ваши вопросы в вашей игре. Продлевается каждые 30 дней, отключить можно в любой момент.",
    solo_year: "Allay отвечает на ваши вопросы в вашей игре 365 дней, лимит пополняется каждый месяц.",
  },
  invoice_ready: "Ваш счёт:",
  paid: "Спасибо! Allay работает на сервере {server} до {date}.",
  renewed: "Подписка продлена: Allay работает на сервере {server} до {date}.",
  status_title: "📋 Ваши серверы. Нажмите на сервер, чтобы открыть его:",
  status_active: "Работает до {date}",
  status_inactive: "Не оплачен",
  status_quota: "израсходовано {percent}% лимита, пополнение {date}",
  status_quota_spent: "Лимит исчерпан",
  status_renews: "Продлевается сам",
  status_solo_bound: "Solo: отвечает одному игроку, он уже выбран",
  status_solo_free: "Solo: достанется первому игроку, который спросит",
  release_button: "🔄 Передать другому игроку",
  released: "Готово: {server} достанется следующему игроку, который спросит.",
  release_wait: "Передать другому игроку снова можно {date}.",
  stop_button: "Отключить продление",
  resume_button: "Включить продление",
  renew_button: "💳 Оплатить или продлить",
  stopped: "Продление отключено. Allay работает до {date}.",
  resumed: "Продление снова включено.",
  not_yours: "Этот сервер привязан к другому аккаунту Telegram.",
  unavailable: "Этот тариф сейчас нельзя оплатить. Попробуйте ещё раз из /status.",
  refunded: "Возвращено {stars} ⭐ за {server}.",
  revoked: "Платежи за {server} возвращены: {stars} ⭐ снова на вашем балансе, а лицензия Allay этого сервера аннулирована. Чтобы Allay снова работал там, оператор удаляет plugins/Allay/license.key и выполняет /allay link.",

};

const es: Texts = {
  about:
    "Allay es un asistente de IA para servidores de Minecraft: los jugadores preguntan en el chat y responde con lo que ve en el juego.\n\nAquí se paga en Telegram Stars. Ejecuta /allay link en tu servidor como operador, o en tu propio mundo con el mod, abre el enlace y elige un plan: una semana, un mes que se renueva solo o un año.",
  short_about: "Pagos de Allay, el asistente de IA para servidores de Minecraft, en Telegram Stars.",
  command_status: "Tus servidores, sus límites y el pago",
  command_start: "Cómo vincular un servidor",
  welcome:
    "👋 ¡Hola! Aquí se paga Allay, el asistente de IA para Minecraft, con Telegram Stars.\n\nCómo empezar:\n1️⃣ Instala Allay: el plugin en Paper o Spigot, o el mod en Fabric o NeoForge.\n2️⃣ En el juego, ejecuta /allay link: como operador o en tu propio mundo.\n3️⃣ Toca el enlace que muestra Allay. Te trae de vuelta aquí: elige un plan, paga y Allay responde al momento.\n\n🔑 Con tu propia clave de IA, Allay aquí no cuesta nada.",
  download_button: "📥 Descargar Allay",
  guide_button: "📖 Guía de instalación",
  servers_button: "📋 Mis servidores",
  howto_button: "➕ Vincular otro servidor",
  back_button: "⬅️ Todos los servidores",
  chatter: "🤖 Aquí me ocupo de los pagos y los servidores. Para preguntarle algo a Allay, escribe /ask en el juego.",
  claimed: "El servidor {server} está vinculado a tu cuenta de Telegram.",
  claim_failed: "Este enlace caducó o ya se usó. Vuelve a ejecutar /allay link en el servidor.",
  plans: "Elige un plan. Si pagas mientras un plan sigue activo, se suma: el límite crece al momento y la fecha final se aplaza.",
  more: "¿Necesitas más de lo que da un año? Escríbenos: {contact}",
  plan: {
    week: "Semana: 7 días, para probar o para un servidor pequeño",
    month: "Mes: 30 días, se renueva solo cada mes",
    year: "Año: 365 días, el límite se recarga cada mes",
    solo_week: "Semana Solo: 7 días solo para ti, en tu propio juego",
    solo_month: "Mes Solo: 30 días solo para ti, se renueva solo cada mes",
    solo_year: "Año Solo: 365 días solo para ti, el límite se recarga cada mes",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pagar {stars} ⭐",
  invoice_title: { week: "Allay por una semana", month: "Allay por un mes", year: "Allay por un año", solo_week: "Allay Solo por una semana", solo_month: "Allay Solo por un mes", solo_year: "Allay Solo por un año" },
  invoice_description: {
    week: "Allay responde a las preguntas de tus jugadores en el servidor {server} durante 7 días.",
    month: "Allay responde a las preguntas de tus jugadores en el servidor {server}. Se renueva cada 30 días; puedes detenerlo cuando quieras.",
    year: "Allay responde a las preguntas de tus jugadores en el servidor {server} durante 365 días, con el límite recargado cada mes.",
    solo_week: "Allay responde a tus preguntas en tu juego durante 7 días.",
    solo_month: "Allay responde a tus preguntas en tu juego. Se renueva cada 30 días; puedes detenerlo cuando quieras.",
    solo_year: "Allay responde a tus preguntas en tu juego durante 365 días, con el límite recargado cada mes.",
  },
  invoice_ready: "Aquí tienes tu factura:",
  paid: "¡Gracias! Allay está activo en el servidor {server} hasta el {date}.",
  renewed: "Tu suscripción se renovó: Allay está activo en el servidor {server} hasta el {date}.",
  status_title: "📋 Tus servidores. Toca uno para ver los detalles:",
  status_active: "Activo hasta el {date}",
  status_inactive: "Sin pagar",
  status_quota: "{percent}% del límite usado, se recarga el {date}",
  status_quota_spent: "El límite está agotado",
  status_renews: "Se renueva solo",
  status_solo_bound: "Solo: responde a un jugador, que ya lo tiene",
  status_solo_free: "Solo: será del primer jugador que pregunte",
  release_button: "🔄 Pasar a otro jugador",
  released: "Listo: {server} será del próximo jugador que pregunte.",
  release_wait: "Podrás pasarlo a otro jugador otra vez el {date}.",
  stop_button: "Detener la renovación",
  resume_button: "Reanudar la renovación",
  renew_button: "💳 Pagar o ampliar",
  stopped: "Renovación detenida. Allay sigue activo hasta el {date}.",
  resumed: "La renovación vuelve a estar activa.",
  not_yours: "Este servidor está vinculado a otra cuenta de Telegram.",
  unavailable: "Ahora no se puede pagar este plan. Inténtalo otra vez desde /status.",
  refunded: "Se devolvieron {stars} ⭐ por {server}.",
  revoked: "Te devolvimos los pagos de {server}: {stars} ⭐ vuelven a tu saldo y su licencia de Allay queda revocada. Para usar Allay allí otra vez, un operador borra plugins/Allay/license.key y ejecuta /allay link.",

};

const pt: Texts = {
  about:
    "Allay é um assistente de IA para servidores de Minecraft: os jogadores perguntam no chat, e ele responde com o que vê no jogo.\n\nAqui você paga com Telegram Stars. Execute /allay link no seu servidor como operador, ou no seu próprio mundo com o mod, abra o link e escolha um plano: uma semana, um mês que renova sozinho ou um ano.",
  short_about: "Pagamentos do Allay, o assistente de IA para servidores de Minecraft, em Telegram Stars.",
  command_status: "Seus servidores, os limites e o pagamento",
  command_start: "Como vincular um servidor",
  welcome:
    "👋 Olá! Aqui você paga o Allay, o assistente de IA para Minecraft, com Telegram Stars.\n\nComo começar:\n1️⃣ Instale o Allay: o plugin no Paper ou Spigot, ou o mod no Fabric ou NeoForge.\n2️⃣ No jogo, execute /allay link: como operador ou no seu próprio mundo.\n3️⃣ Toque no link que o Allay mostrar. Ele traz você de volta aqui: escolha um plano, pague e o Allay responde na hora.\n\n🔑 Com a sua própria chave de IA, o Allay não custa nada aqui.",
  download_button: "📥 Baixar o Allay",
  guide_button: "📖 Guia de instalação",
  servers_button: "📋 Meus servidores",
  howto_button: "➕ Vincular outro servidor",
  back_button: "⬅️ Todos os servidores",
  chatter: "🤖 Aqui eu cuido dos pagamentos e dos servidores. Para perguntar algo ao Allay, escreva /ask no jogo.",
  claimed: "O servidor {server} está vinculado à sua conta do Telegram.",
  claim_failed: "Este link expirou ou já foi usado. Execute /allay link no servidor de novo.",
  plans: "Escolha um plano. Um pagamento com um plano ainda ativo se soma a ele: o limite cresce na hora e a data final avança.",
  more: "Precisa de mais do que um ano oferece? Fale conosco: {contact}",
  plan: {
    week: "Semana: 7 dias, para testar ou para um servidor pequeno",
    month: "Mês: 30 dias, renova sozinho todo mês",
    year: "Ano: 365 dias, o limite é recarregado todo mês",
    solo_week: "Semana Solo: 7 dias só para você, no seu próprio jogo",
    solo_month: "Mês Solo: 30 dias só para você, renova sozinho todo mês",
    solo_year: "Ano Solo: 365 dias só para você, o limite é recarregado todo mês",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "Pagar {stars} ⭐",
  invoice_title: { week: "Allay por uma semana", month: "Allay por um mês", year: "Allay por um ano", solo_week: "Allay Solo por uma semana", solo_month: "Allay Solo por um mês", solo_year: "Allay Solo por um ano" },
  invoice_description: {
    week: "O Allay responde às perguntas dos seus jogadores no servidor {server} por 7 dias.",
    month: "O Allay responde às perguntas dos seus jogadores no servidor {server}. Renova a cada 30 dias; você pode parar quando quiser.",
    year: "O Allay responde às perguntas dos seus jogadores no servidor {server} por 365 dias, com o limite recarregado todo mês.",
    solo_week: "O Allay responde às suas perguntas no seu jogo por 7 dias.",
    solo_month: "O Allay responde às suas perguntas no seu jogo. Renova a cada 30 dias; você pode parar quando quiser.",
    solo_year: "O Allay responde às suas perguntas no seu jogo por 365 dias, com o limite recarregado todo mês.",
  },
  invoice_ready: "Aqui está a sua fatura:",
  paid: "Obrigado! O Allay está ativo no servidor {server} até {date}.",
  renewed: "Sua assinatura foi renovada: o Allay está ativo no servidor {server} até {date}.",
  status_title: "📋 Seus servidores. Toque em um para ver os detalhes:",
  status_active: "Ativo até {date}",
  status_inactive: "Não pago",
  status_quota: "{percent}% do limite usado, recarrega em {date}",
  status_quota_spent: "O limite acabou",
  status_renews: "Renova sozinho",
  status_solo_bound: "Solo: responde a um jogador, que já o tem",
  status_solo_free: "Solo: fica com o primeiro jogador que perguntar",
  release_button: "🔄 Passar para outro jogador",
  released: "Pronto: {server} fica com o próximo jogador que perguntar.",
  release_wait: "Você pode passar para outro jogador de novo em {date}.",
  stop_button: "Parar a renovação",
  resume_button: "Retomar a renovação",
  renew_button: "💳 Pagar ou estender",
  stopped: "Renovação parada. O Allay continua ativo até {date}.",
  resumed: "A renovação voltou a funcionar.",
  not_yours: "Este servidor está vinculado a outra conta do Telegram.",
  unavailable: "Não dá para pagar este plano agora. Tente de novo pelo /status.",
  refunded: "Foram devolvidas {stars} ⭐ por {server}.",
  revoked: "Os pagamentos de {server} foram devolvidos: {stars} ⭐ voltaram para o seu saldo, e a licença do Allay desse servidor foi revogada. Para usar o Allay lá de novo, um operador apaga plugins/Allay/license.key e executa /allay link.",

};

const de: Texts = {
  about:
    "Allay ist ein KI-Helfer für Minecraft-Server: Spieler fragen im Chat, und er antwortet mit dem, was er im Spiel sieht.\n\nHier bezahlst du ihn mit Telegram Stars. Führ /allay link als Operator auf deinem Server oder mit dem Mod in deiner eigenen Welt aus, öffne den Link und wähl einen Tarif: eine Woche, einen Monat, der sich selbst verlängert, oder ein Jahr.",
  short_about: "Zahlungen für Allay, den KI-Helfer für Minecraft-Server, in Telegram Stars.",
  command_status: "Deine Server, ihre Limits und Bezahlen",
  command_start: "Wie du einen Server verknüpfst",
  welcome:
    "👋 Hi! Hier bezahlst du Allay, den KI-Helfer für Minecraft, mit Telegram Stars.\n\nSo fängst du an:\n1️⃣ Installier Allay: das Plugin auf Paper oder Spigot oder den Mod auf Fabric oder NeoForge.\n2️⃣ Führ im Spiel /allay link aus – als Operator oder in deiner eigenen Welt.\n3️⃣ Tipp auf den Link, den Allay zeigt. Er bringt dich hierher zurück: Tarif wählen, bezahlen, und Allay antwortet sofort.\n\n🔑 Mit deinem eigenen KI-Schlüssel kostet Allay hier nichts.",
  download_button: "📥 Allay herunterladen",
  guide_button: "📖 Anleitung",
  servers_button: "📋 Meine Server",
  howto_button: "➕ Weiteren Server verknüpfen",
  back_button: "⬅️ Alle Server",
  chatter: "🤖 Hier kümmere ich mich um Zahlungen und Server. Um Allay etwas zu fragen, schreib im Spiel /ask.",
  claimed: "Server {server} ist mit deinem Telegram-Konto verknüpft.",
  claim_failed: "Dieser Link ist abgelaufen oder wurde schon benutzt. Führ /allay link auf dem Server noch einmal aus.",
  plans: "Wähl einen Tarif. Zahlst du, während ein Tarif läuft, kommt er obendrauf: Das Limit wächst sofort, und das Enddatum rückt nach hinten.",
  more: "Brauchst du mehr, als ein Jahr bietet? Schreib uns: {contact}",
  plan: {
    week: "Woche: 7 Tage, zum Ausprobieren oder für einen kleinen Server",
    month: "Monat: 30 Tage, verlängert sich jeden Monat von selbst",
    year: "Jahr: 365 Tage, das Limit füllt sich jeden Monat neu auf",
    solo_week: "Solo-Woche: 7 Tage nur für dich, in deinem eigenen Spiel",
    solo_month: "Solo-Monat: 30 Tage nur für dich, verlängert sich jeden Monat von selbst",
    solo_year: "Solo-Jahr: 365 Tage nur für dich, das Limit füllt sich jeden Monat neu auf",
  },
  plan_button: "{plan} · {stars} ⭐",
  pay_button: "{stars} ⭐ bezahlen",
  invoice_title: { week: "Allay für eine Woche", month: "Allay für einen Monat", year: "Allay für ein Jahr", solo_week: "Allay Solo für eine Woche", solo_month: "Allay Solo für einen Monat", solo_year: "Allay Solo für ein Jahr" },
  invoice_description: {
    week: "Allay beantwortet 7 Tage lang die Fragen deiner Spieler auf Server {server}.",
    month: "Allay beantwortet die Fragen deiner Spieler auf Server {server}. Verlängert sich alle 30 Tage, du kannst es jederzeit stoppen.",
    year: "Allay beantwortet 365 Tage lang die Fragen deiner Spieler auf Server {server}, das Limit füllt sich jeden Monat neu auf.",
    solo_week: "Allay beantwortet 7 Tage lang deine Fragen in deinem Spiel.",
    solo_month: "Allay beantwortet deine Fragen in deinem Spiel. Verlängert sich alle 30 Tage, du kannst es jederzeit stoppen.",
    solo_year: "Allay beantwortet 365 Tage lang deine Fragen in deinem Spiel, das Limit füllt sich jeden Monat neu auf.",
  },
  invoice_ready: "Hier ist deine Rechnung:",
  paid: "Danke! Allay läuft auf Server {server} bis zum {date}.",
  renewed: "Dein Abo wurde verlängert: Allay läuft auf Server {server} bis zum {date}.",
  status_title: "📋 Deine Server. Tipp auf einen für Details:",
  status_active: "Aktiv bis {date}",
  status_inactive: "Nicht bezahlt",
  status_quota: "{percent} % des Limits verbraucht, füllt sich am {date} auf",
  status_quota_spent: "Das Limit ist aufgebraucht",
  status_renews: "Verlängert sich von selbst",
  status_solo_bound: "Solo: antwortet einem Spieler, der es schon hat",
  status_solo_free: "Solo: gehört dem ersten Spieler, der fragt",
  release_button: "🔄 An anderen Spieler geben",
  released: "Erledigt: {server} gehört dem nächsten Spieler, der fragt.",
  release_wait: "An einen anderen Spieler geben kannst du es wieder am {date}.",
  stop_button: "Verlängerung stoppen",
  resume_button: "Verlängerung fortsetzen",
  renew_button: "💳 Bezahlen oder verlängern",
  stopped: "Verlängerung gestoppt. Allay läuft noch bis zum {date}.",
  resumed: "Die Verlängerung ist wieder an.",
  not_yours: "Dieser Server ist mit einem anderen Telegram-Konto verknüpft.",
  unavailable: "Dieser Tarif lässt sich gerade nicht bezahlen. Versuch es über /status noch einmal.",
  refunded: "{stars} ⭐ für {server} zurückerstattet.",
  revoked: "Deine Zahlungen für {server} sind zurückerstattet: {stars} ⭐ liegen wieder auf deinem Guthaben, und die Allay-Lizenz des Servers ist widerrufen. Damit Allay dort wieder läuft, löscht ein Operator plugins/Allay/license.key und führt /allay link aus.",

};

const LANGUAGES: Record<string, Texts> = { en, ru, es, pt, de };

export const LANGUAGE_CODES = Object.keys(LANGUAGES);

export const PLAN_NAMES: Record<string, Record<PlanId, string>> = {
  en: { week: "Week", month: "Month", year: "Year", solo_week: "Solo week", solo_month: "Solo month", solo_year: "Solo year" },
  ru: { week: "Неделя", month: "Месяц", year: "Год", solo_week: "Solo-неделя", solo_month: "Solo-месяц", solo_year: "Solo-год" },
  es: { week: "Semana", month: "Mes", year: "Año", solo_week: "Semana Solo", solo_month: "Mes Solo", solo_year: "Año Solo" },
  pt: { week: "Semana", month: "Mês", year: "Ano", solo_week: "Semana Solo", solo_month: "Mês Solo", solo_year: "Ano Solo" },
  de: { week: "Woche", month: "Monat", year: "Jahr", solo_week: "Solo-Woche", solo_month: "Solo-Monat", solo_year: "Solo-Jahr" },
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
