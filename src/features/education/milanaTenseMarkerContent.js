export const MARKER_TENSES=[
 {id:'PS',group:'Present',name:'Present Simple',meaning:'привычки, факты, расписание',form:'I/you/we/they + V; he/she + V-s; do/does not + V; Do/Does ... V?',
 markers:'<b>always</b> — всегда; <b>usually</b> — обычно (ю́жуэли); <b>normally</b> — как правило; <b>often</b> — часто (о́фэн); <b>frequently</b> — часто; <b>sometimes</b> — иногда; <b>occasionally</b> — время от времени (экэ́йжэнали); <b>rarely/seldom</b> — редко; <b>hardly ever</b> — почти никогда; <b>never</b> — никогда; <b>every day/week/month/year</b> — каждый день/неделю/месяц/год; <b>on Mondays</b> — по понедельникам; <b>once/twice a week</b> — раз/дважды в неделю; <b>as a rule</b> — как правило; <b>in general</b> — в целом',
 ex:[
 ['+','My sister <b>usually</b> walks to school.','Сестра обычно ходит в школу пешком.'],
 ['+','The pharmacy opens at nine <b>every day</b>.','Аптека открывается в девять каждый день.'],
 ['−','I <b>never</b> leave the door unlocked.','Я никогда не оставляю дверь незапертой.'],
 ['−','Dad does not drive to work <b>on Fridays</b>.','По пятницам папа не ездит на работу на машине.'],
 ['?','Do you <b>often</b> cook dinner at home?','Ты часто готовишь дома ужин?'],
 ['?','Does your bus <b>always</b> arrive on time?','Твой автобус всегда приходит вовремя?']]},
 {id:'PC',group:'Present',name:'Present Continuous',meaning:'происходит сейчас; временная ситуация; личный план',form:'am/is/are + V-ing; am/is/are not + V-ing; Am/Is/Are ... V-ing?',
 markers:'<b>now/right now</b> — сейчас/прямо сейчас; <b>at the moment</b> — в данный момент; <b>currently</b> — в настоящее время (ка́рэнтли); <b>at present</b> — сейчас; <b>today</b> — сегодня; <b>this week/month</b> — на этой неделе/в этом месяце; <b>these days</b> — в последнее время; <b>for the time being</b> — пока что; <b>Look!</b> — смотри!; <b>Listen!</b> — послушай!; <b>still</b> — всё ещё; <b>always/constantly</b> — постоянно (с раздражением)',
 ex:[
 ['+','I am <b>currently</b> preparing for my exam.','Я сейчас готовлюсь к экзамену.'],
 ['+','We are staying with Grandma <b>this week</b>.','На этой неделе мы живём у бабушки.'],
 ['−','Mum is not working <b>today</b>; she is ill.','Мама сегодня не работает: она заболела.'],
 ['−','I am not using my phone <b>right now</b>.','Я прямо сейчас не пользуюсь телефоном.'],
 ['?','Are you <b>still</b> waiting for the bus?','Ты всё ещё ждёшь автобус?'],
 ['?','Are they moving house <b>this month</b>?','Они переезжают в этом месяце?']]},
 {id:'PP',group:'Present',name:'Present Perfect',meaning:'прошлое важно ДЛЯ СЕЙЧАС: результат, опыт, незавершённый период',form:'have/has + V3; have/has not + V3; Have/Has ... V3?',
 markers:'<b>already</b> — уже; <b>just</b> — только что; <b>yet</b> — ещё/уже (в отрицаниях/вопросах); <b>ever</b> — когда-либо; <b>never</b> — никогда; <b>before</b> — раньше; <b>recently/lately</b> — недавно/в последнее время; <b>so far/up to now</b> — до сих пор; <b>still</b> — всё ещё; <b>since</b> — с момента; <b>for</b> — в течение; <b>this week/month/year</b> — за этот период; <b>today</b> — сегодня (период не закончился); <b>once/twice</b> — раз/дважды; <b>in the last few days</b> — за последние дни',
 ex:[
 ['+','I have <b>just</b> found my keys.','Я только что нашла ключи — они у меня.'],
 ['+','She has visited the museum twice <b>this year</b>.','Она дважды была в музее в этом году.'],
 ['−','We have not received the parcel <b>yet</b>.','Мы ещё не получили посылку.'],
 ['−','He has <b>never</b> tried sushi.','Он никогда не пробовал суши.'],
 ['?','Have you <b>ever</b> missed a flight?','Ты когда-нибудь опаздывала на самолёт?'],
 ['?','Has the doctor called <b>yet</b>?','Врач уже позвонил?']]},
 {id:'PPC',group:'Present',name:'Present Perfect Continuous',meaning:'процесс начался раньше и длится до сейчас / только что закончился с видимым следом',form:'have/has + been + V-ing; have/has not been + V-ing; Have/Has ... been V-ing?',
 markers:'<b>for</b> — в течение (длительность); <b>since</b> — с момента (начало); <b>all day/morning/week</b> — весь день/утро/неделю; <b>how long</b> — как долго; <b>lately/recently</b> — в последнее время; <b>these past few days</b> — последние несколько дней; <b>up to now</b> — до сих пор; <b>still</b> — всё ещё; <b>for ages</b> — целую вечность (эйджиз)',
 ex:[
 ['+','I have been studying <b>for two hours</b>.','Я занимаюсь уже два часа (процесс важен).'],
 ['+','She has been coughing <b>since Monday</b>.','Она кашляет с понедельника.'],
 ['−','I have not been sleeping well <b>lately</b>.','В последнее время я плохо сплю.'],
 ['−','He has not been going to the gym <b>this month</b>.','В этом месяце он не ходит в спортзал.'],
 ['?','<b>How long</b> have you been waiting here?','Как долго ты здесь ждёшь?'],
 ['?','Have you been working <b>all morning</b>?','Ты работала всё утро?']]},
 {id:'PaS',group:'Past',name:'Past Simple',meaning:'завершённое событие в конкретном прошлом',form:'V2 / did not + V / Did ... + V?',
 markers:'<b>yesterday</b> — вчера; <b>last night/week/month/year</b> — прошлой ночью/на прошлой неделе; <b>ago</b> — назад; <b>in 2020</b> — в 2020 году; <b>then</b> — тогда; <b>the other day</b> — на днях; <b>once</b> — однажды; <b>when I was a child</b> — когда я была ребёнком; <b>at that time</b> — в то время; <b>on Monday</b> — в понедельник (конкретный прошедший); <b>formerly</b> — прежде; <b>used to</b> — раньше обычно (конструкция прошлого)',
 ex:[
 ['+','I lost my travel card <b>yesterday</b>.','Вчера я потеряла проездной.'],
 ['+','We moved into this flat <b>three years ago</b>.','Мы переехали в эту квартиру три года назад.'],
 ['−','I did not see the doctor <b>last week</b>.','На прошлой неделе я не была у врача.'],
 ['−','She did not call me <b>on Sunday</b>.','В воскресенье она мне не позвонила.'],
 ['?','Did you finish the report <b>last night</b>?','Ты закончила отчёт вчера вечером?'],
 ['?','Where did they live <b>in 2019</b>?','Где они жили в 2019 году?']]},
 {id:'PaC',group:'Past',name:'Past Continuous',meaning:'процесс в определённый момент прошлого / фон события',form:'was/were + V-ing; was/were not + V-ing; Was/Were ... V-ing?',
 markers:'<b>at 7 yesterday</b> — вчера в семь; <b>at that moment</b> — в тот момент; <b>while</b> — пока, в то время как; <b>when</b> — когда (действие прервало процесс); <b>all evening</b> — весь вечер; <b>from 5 to 6</b> — с пяти до шести; <b>this time yesterday</b> — вчера в это время; <b>as</b> — пока/когда (одновременный процесс)',
 ex:[
 ['+','I was cooking <b>when</b> the lights went out.','Я готовила, когда выключился свет.'],
 ['+','<b>At eight yesterday</b>, Mum was driving home.','Вчера в восемь мама ехала домой.'],
 ['−','I was not sleeping <b>when</b> you called.','Я не спала, когда ты позвонила.'],
 ['−','They were not playing outside <b>at that moment</b>.','В тот момент они не играли на улице.'],
 ['?','What were you doing <b>at nine last night</b>?','Что ты делала вчера в девять вечера?'],
 ['?','Were you listening <b>while</b> I explained?','Ты слушала, пока я объясняла?']]},
 {id:'PaP',group:'Past',name:'Past Perfect',meaning:'действие завершилось ДО другого момента в прошлом',form:'had + V3; had not + V3; Had ... + V3?',
 markers:'<b>by the time</b> — к тому моменту, как; <b>before</b> — до того как; <b>after</b> — после того как; <b>already</b> — уже; <b>just</b> — только что (к прошлому моменту); <b>never/ever</b> — никогда/когда-либо до того; <b>by then</b> — к тому времени; <b>by 8 p.m.</b> — к восьми вечера (в прошлом); <b>until/till</b> — до момента; <b>once</b> — после того как',
 ex:[
 ['+','<b>By the time</b> I arrived, the train had left.','Когда я пришла, поезд уже ушёл.'],
 ['+','She had <b>already</b> eaten before the meeting.','До собрания она уже поела.'],
 ['−','I had not packed <b>when</b> the taxi arrived.','Когда приехало такси, я ещё не собралась.'],
 ['−','He had <b>never</b> flown before that trip.','До той поездки он никогда не летал.'],
 ['?','Had you finished homework <b>before</b> dinner?','Ты закончила домашку до ужина?'],
 ['?','Had the film started <b>by the time</b> you arrived?','Фильм уже начался к твоему приходу?']]},
 {id:'PaPC',group:'Past',name:'Past Perfect Continuous',meaning:'процесс длился ДО момента в прошлом; важна длительность или причина состояния',form:'had been + V-ing; had not been + V-ing; Had ... been V-ing?',
 markers:'<b>for</b> — в течение; <b>since</b> — с момента; <b>how long</b> — как долго; <b>all morning/day</b> — всё утро/день (до прошлого момента); <b>before</b> — перед тем как; <b>by the time</b> — к тому моменту; <b>when</b> — когда (в прошлом); <b>until</b> — вплоть до',
 ex:[
 ['+','I had been driving <b>for four hours</b> when we stopped.','Я вела машину четыре часа до остановки.'],
 ['+','She was tired: she had been studying <b>all night</b>.','Она устала: всю ночь занималась.'],
 ['−','He had not been sleeping well <b>before</b> the exam.','До экзамена он плохо спал.'],
 ['−','We had not been waiting <b>long</b> when the bus came.','Мы ждали недолго, когда пришёл автобус.'],
 ['?','<b>How long</b> had you been working before you took a break?','Как долго ты работала до перерыва?'],
 ['?','Had it been raining <b>all morning</b> before you left?','Дождь шёл всё утро до твоего ухода?']]},
 {id:'FS',group:'Future',name:'Future Simple',meaning:'решение сейчас, прогноз, обещание, будущее событие',form:'will + V; will not (won’t) + V; Will ... + V?',
 markers:'<b>tomorrow</b> — завтра; <b>next week/month/year</b> — на следующей неделе/в будущем месяце; <b>soon</b> — скоро; <b>later</b> — позже; <b>in an hour</b> — через час; <b>one day/someday</b> — когда-нибудь; <b>in the future</b> — в будущем; <b>I think</b> — думаю; <b>probably</b> — вероятно; <b>perhaps/maybe</b> — возможно; <b>by tomorrow</b> — к завтрашнему дню (но для готового результата — Future Perfect)',
 ex:[
 ['+','I will call you <b>tomorrow</b> after school.','Я позвоню тебе завтра после школы.'],
 ['+','<b>I think</b> the doctor will help us.','Думаю, врач нам поможет.'],
 ['−','I will not be at home <b>tonight</b>.','Сегодня вечером меня не будет дома.'],
 ['−','We will not buy a new phone <b>next month</b>.','В следующем месяце телефон не купим.'],
 ['?','Will you be free <b>later</b>?','Ты будешь свободна позже?'],
 ['?','Will the parcel arrive <b>tomorrow</b>?','Посылка придёт завтра?']]},
 {id:'FC',group:'Future',name:'Future Continuous',meaning:'процесс В конкретный будущий момент; вежливые вопросы о планах',form:'will be + V-ing; will not be + V-ing; Will ... be V-ing?',
 markers:'<b>at 8 tomorrow</b> — завтра в восемь; <b>this time tomorrow</b> — завтра в это время; <b>all evening</b> — весь вечер; <b>from 5 to 7</b> — с пяти до семи; <b>when you arrive</b> — когда ты приедешь; <b>still</b> — всё ещё; <b>at that time next week</b> — в это время на следующей неделе',
 ex:[
 ['+','<b>This time tomorrow</b> I will be taking my exam.','Завтра в это время я буду сдавать экзамен.'],
 ['+','I will be working <b>from six to eight</b>.','С шести до восьми я буду работать.'],
 ['−','I will not be sleeping <b>at midnight</b>; I have a flight.','В полночь не буду спать: у меня рейс.'],
 ['−','We will not be using the car <b>tomorrow afternoon</b>.','Завтра днём машиной не будем пользоваться.'],
 ['?','Will you be studying <b>at seven</b>?','Ты будешь заниматься в семь?'],
 ['?','Will you <b>still</b> be working when I get home?','Ты ещё будешь работать, когда я вернусь?']]},
 {id:'FP',group:'Future',name:'Future Perfect',meaning:'результат уже будет готов К определённому моменту в будущем',form:'will have + V3; will not have + V3; Will ... have + V3?',
 markers:'<b>by</b> — к; <b>by the time</b> — к тому моменту как; <b>by tomorrow/Friday</b> — к завтрашнему дню/пятнице; <b>by the end of</b> — к концу; <b>before</b> — прежде чем; <b>within two days</b> — в пределах двух дней; <b>by then</b> — к тому времени; <b>already</b> — уже (к будущей точке)',
 ex:[
 ['+','I will have finished my essay <b>by Friday</b>.','К пятнице сочинение будет закончено.'],
 ['+','<b>By the time</b> you arrive, we will have eaten.','К твоему приезду мы уже поедим.'],
 ['−','I will not have saved enough money <b>by June</b>.','К июню я не накоплю достаточно денег.'],
 ['−','The repair will not have finished <b>by noon</b>.','К полудню ремонт ещё не закончат.'],
 ['?','Will you have done the homework <b>by eight</b>?','Ты закончишь домашку к восьми?'],
 ['?','Will they have moved <b>before</b> school starts?','Они успеют переехать до начала занятий?']]},
 {id:'FPC',group:'Future',name:'Future Perfect Continuous',meaning:'сколько времени процесс будет длиться К будущей точке',form:'will have been + V-ing; will not have been + V-ing; Will ... have been V-ing?',
 markers:'<b>by ... for</b> — к ... уже в течение; <b>by the time ... for</b> — к моменту ... уже столько-то; <b>for ten years by 2030</b> — десять лет к 2030 году; <b>by next month</b> — к следующему месяцу; <b>how long ... by</b> — сколько времени к моменту',
 ex:[
 ['+','<b>By June</b>, I will have been studying English <b>for three years</b>.','К июню будет три года, как я учу английский.'],
 ['+','<b>By eight</b>, Dad will have been driving <b>for six hours</b>.','К восьми папа будет за рулём уже шесть часов.'],
 ['−','<b>By May</b>, she will not have been working here <b>for a year</b> yet.','К маю ещё не будет года её работы здесь.'],
 ['−','<b>By December</b>, I will not have been training <b>for six months</b>.','К декабрю ещё не будет полугода моих тренировок.'],
 ['?','<b>By Friday</b>, will you have been waiting <b>for a week</b>?','К пятнице будет уже неделя твоего ожидания?'],
 ['?','<b>By 2030</b>, how long will you have been living here?','К 2030 году сколько лет ты уже будешь здесь жить?']]}
];

const HEADER=[
 '🇬🇧 <b>СЛОВА-МАРКЕРЫ АНГЛИЙСКИХ ВРЕМЁН</b>',
 'Маркеры — <b>подсказки, а не законы</b>. <b>for</b>, <b>since</b>, <b>when</b>, <b>already</b> и <b>by</b> работают только вместе со смыслом и точкой отсчёта.',
 'V — начальная форма; V2 — прошедшая; V3 — третья форма; V-ing — форма с -ing.',
 'Знаки: ✅ утверждение, ⛔ отрицание, ❓ вопрос. Слова-маркеры выделены <b>жирным</b>.',
].join('\n');
const SIGN={'+':'✅','−':'⛔','?':'❓'};
function block(tense){
 return [
 '<b>'+tense.name+'</b> — '+tense.meaning+'.',
 '<i>Форма:</i> '+tense.form,
 '🔎 '+tense.markers,
 ...tense.ex.map(e=>SIGN[e[0]]+' '+e[1]+'\n    ↳ '+e[2]),
 ].join('\n');
}
export function makeMarkerTheoryMessages(){
 const messages=[HEADER];
 for(const group of ['Present','Past','Future']){
  const records=MARKER_TENSES.filter(x=>x.group===group);
  let current='📚 <b>'+group+' — 4 времени</b>',part=1;
  for(const record of records){
   const next=current+'\n\n'+block(record);
   if(next.length>3900){
    messages.push(current);
    current='📚 <b>'+group+' — продолжение '+(++part)+'</b>\n\n'+block(record);
   }else current=next;
  }
  messages.push(current);
 }
 messages.push([
 '🧠 <b>ГЛАВНЫЕ РАЗЛИЧИЯ PERFECT</b>',
 '<b>Present Perfect:</b> have/has + V3 → результат важен <b>сейчас</b>. I <b>have lost</b> my key. — Я потеряла ключ, сейчас его нет.',
 '<b>Past Perfect:</b> had + V3 → результат был готов <b>до другого прошлого</b>. I <b>had lost</b> my key <b>before</b> I got home. — Я потеряла ключ до того, как пришла домой.',
 '<b>Past Simple:</b> событие в законченном прошлом. I lost it <b>yesterday</b>. — Я потеряла его вчера.',
 '<b>Present Perfect Continuous:</b> have been + V-ing → как долго процесс длится / почему виден след: I <b>have been painting</b>; my hands are dirty. — Я красила, поэтому руки грязные.',
 '<b>Present Perfect:</b> сколько готово: I <b>have painted</b> three walls. — Я покрасила три стены.',
 '<b>Past Perfect Continuous:</b> длилось до прошлого момента: She <b>had been waiting</b> for an hour when he came. — Она ждала час до его прихода.',
 '<b>Future Perfect:</b> к будущему моменту <b>будет готово</b>: I <b>will have finished</b> by six. — Закончу к шести.',
 '<b>Future Perfect Continuous:</b> к будущему моменту <b>сколько будет длиться</b>: By six, I <b>will have been working</b> for eight hours. — К шести проработаю уже восемь часов.',
 '⚠️ <b>since</b> = с момента, <b>for</b> = длительность; оба встречаются в Perfect <b>и</b> Perfect Continuous.',
 '⚠️ <b>by</b> само не гарантирует Perfect; вопрос: «готово к сроку» или «действие в момент»?',
 ].join('\n'));
 messages.push([
 '🧭 <b>МАРКЕРЫ-ЛОВУШКИ И СМЫСЛ</b>',
 '• <b>today / this week</b> (сегодня / на этой неделе): Present Perfect, если период ещё продолжается; Past Simple — когда событие привязано к законченному прошлому; Present Continuous — процесс сейчас.',
 '• <b>already / just / yet</b> (уже / только что / ещё): часто Present Perfect, но возможны Past Perfect и другие времена с прошлой/будущей точкой отсчёта.',
 '• <b>when</b> (когда) — не время, а союз. I <b>was reading</b> when he called — я читала, когда он позвонил.',
 '• <b>while</b> (пока) часто сопровождает длительный процесс, но время выбираем по контексту.',
 '• <b>since</b> (с момента) — точка начала; <b>for</b> (в течение) — период. I have lived here <b>since 2022</b> = <b>for four years</b> (если сейчас 2026).',
 '• Статические глаголы <b>know, believe, own, like, understand</b> (знать, верить, владеть, любить, понимать) обычно не требуют Continuous: I <b>have known</b> her for years.',
 '• <b>used to</b> (раньше имел обыкновение) — прошлая привычка, а не отдельное время.',
 '• После <b>when / as soon as / until / before / after / if</b> (когда / как только / пока не / до / после / если) в придаточном времени часто ставим Present Simple вместо will: <b>When</b> she comes, I <b>will call</b> you.',
 '• <b>tomorrow</b> не заставляет ставить will: I <b>am meeting</b> a friend tomorrow (договорённость). The train <b>leaves</b> tomorrow at nine (расписание).',
 '• <b>yesterday / last year / two days ago</b> — законченное прошлое, обычно Past Simple; не используй Present Perfect с конкретной датой события.',
 '• В заданиях надо объяснить смысл: <b>результат, процесс, длительность, привычка, порядок событий и точка отсчёта</b>.',
 ].join('\n'));
 return messages;
}
export function markerTheoryStats(){
 const all=makeMarkerTheoryMessages();
 return {messageCount:all.length,lengths:all.map(m=>m.length),exampleCount:MARKER_TENSES.reduce((n,t)=>n+t.ex.length,0),tenseCount:MARKER_TENSES.length};
}
