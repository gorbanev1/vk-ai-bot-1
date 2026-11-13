import {MARKER_TENSES} from './milanaTenseMarkerContent.js';
const F=(text,expected,why)=>({type:'fill',text,expected,why});
const E=(text,expected,why)=>({type:'explain',text,expected,why});
const O=(text,expected,why)=>({type:'oral',text,expected,why});
const C=(text,options,correct,why)=>({type:'choice',text,options,correct,expected:correct,why});
const SCENARIOS={
 PS:[
 F('The library ___ (close) at 6 p.m. every Friday. — Библиотека закрывается каждую пятницу в шесть. Заполни форму.','closes','Расписание: 3-е лицо + -s.'),
 E('My brother usually cycles to school. — Брат обычно ездит в школу на велосипеде. Почему не Present Continuous?','Повторяющаяся привычка, usually, Present Simple.','Учитывай частоту.'),
 F('She ___ (not/eat) meat. — Она не ест мясо. Составь отрицание.','does not eat / doesn’t eat','Doesn’t + V без -s.'),
 C('«Я работаю в больнице» (постоянная работа). Что естественнее?',['I am working at a hospital now.','I work at a hospital.','I have been working today.','I worked yesterday.'],'I work at a hospital.','Постоянная работа — Present Simple.'),
 E('Можно ли по never всегда определить Present Simple? Разбери: I have never been to Spain. — Я никогда не была в Испании.','Нет: Present Perfect из-за опыта, never бывает и в Simple.','Маркеры неоднозначны.'),
 O('Устно расскажи две реальные привычки о своём учебном дне по-английски, используй usually и never, объясни время.','Два осмысленных Present Simple предложения и перевод.','Привычки сейчас.'),
 F('What time ___ the last bus ___ (leave)? — Во сколько отходит последний автобус?','does ... leave','Вопрос о расписании.'),
 E('I sometimes read before bed / I am reading now. — Иногда читаю перед сном / сейчас читаю. В чём различие?','Привычка vs процесс сейчас.','Смысл обстоятельств.')],
 PC:[
 F('I ___ (carry) groceries right now. — Я прямо сейчас несу тяжёлые сумки с продуктами.','am carrying','Процесс сейчас.'),
 C('В этом месяце Лена живёт у бабушки, потом вернётся домой. Выбери:', ['Lena lives with her grandma every year.','Lena is staying with her grandma this month.','Lena has stayed there forever.','Lena stayed there last month.'],'Lena is staying with her grandma this month.','Временная ситуация.'),
 F('___ you ___ (watch) a film right now? — Ты прямо сейчас смотришь фильм?','Are ... watching','Are + V-ing.'),
 E('I am always losing my keys / I always lose my keys. — Какой вариант может выражать раздражение?','Continuous с always может выражать раздражение; Simple констатирует привычку.','Always не только Simple.'),
 F('She ___ (not/use) the laptop at the moment. — Она не пользуется ноутбуком сейчас.','is not using','Отрицание в текущем процессе.'),
 O('Устно сравни, что обычно делаешь после школы и что делаешь прямо сейчас. Два предложения и объяснение.','Present Simple для привычки и Present Continuous для действия сейчас.','Сравни факты.'),
 E('Почему «I am knowing the answer» обычно неверно? — «Я знаю ответ».','I know the answer: know — глагол состояния.','Continuous со stative verbs редко уместен.'),
 F('We ___ (meet) at the café tomorrow. — Мы договорились встретиться в кафе завтра.','are meeting','Present Continuous для согласованного плана.')],
 PP:[
 C('Потеряла ключ и сейчас не можешь войти. Выбери точную фразу:', ['I lost my key in 2020.','I have lost my key.','I had lost my key before dinner.','I was losing my key.'],'I have lost my key.','Важен результат СЕЙЧАС.'),
 F('My parcel ___ (not/arrive) yet. — Посылка ещё не прибыла.','has not arrived / hasn’t arrived','Yet + результат отсутствует сейчас.'),
 F('I ___ (be) to London once. — Я бывала в Лондоне однажды.','have been','Жизненный опыт без даты.'),
 E('I have seen this film / I saw this film last night. — Почему это не одно и то же?','Опыт/результат сейчас vs конкретный вчерашний вечер.','Last night завершён.'),
 F('Mum ___ (just/come) home. — Мама только что вернулась и сейчас дома.','has just come','Just + текущий результат.'),
 E('Have you finished your homework yet? / Did you finish your homework yesterday? — Как отличаются вопросы?','Готово ли сейчас vs закончила ли вчера.','Точка отсчёта.'),
 O('Устно: что ты УЖЕ успела сегодня и чего ПОКА не сделала? Используй already и yet, дай перевод.','Два предложения have/has+V3, положительное и отрицательное.','События текущего незаконченного периода.'),
 E('I have lived here since 2022 / I lived here in 2022. — Как сказать, если живёшь здесь до сих пор?','I have lived here since 2022; since = начало действия до сейчас.','Связь прошлого с настоящим.'),
 F('I ___ (see) her five minutes ago. — Я увидела её пять минут назад.','saw','Ago — Past Simple.'),
 C('«Ты когда-нибудь летала самолётом?» — опыт без даты. Выбери:', ['Did you fly last summer?','Have you ever flown?','Had you flown before he came?','Will you have flown?'],'Have you ever flown?','Ever + опыт в жизни.')],
 PPC:[
 F('I ___ (run) for an hour; that is why I am sweating. — Я бегаю уже час, поэтому вспотела.','have been running','Процесс и след в настоящем.'),
 C('Готовишься к экзамену 2 часа и ещё занимаешься. Выбери:', ['I studied two hours yesterday.','I have been studying for two hours.','I had studied before lunch.','I will have studied by eight.'],'I have been studying for two hours.','Длительность до настоящего.'),
 F('How long ___ you ___ (wait)? — Как долго ты ждёшь?','have ... been waiting','How long + have been V-ing.'),
 E('I have written three emails / I have been writing emails all morning. — В чём разница?','Три готовых письма vs длительный процесс письма.','Результат vs продолжительность.'),
 E('Почему I have been knowing her for years неверно? Как сказать?','I have known her for years, know — глагол состояния.','Perfect Simple для стативных.'),
 F('She ___ (not/sleep) well lately. — В последнее время она плохо спит.','has not been sleeping','Повторяющаяся проблема в периоде до сейчас.'),
 O('Устно объясни по-английски, почему у человека грязные руки после ремонта. Используй Present Perfect Continuous и перевод.','I have been painting, so my hands are dirty.','Процесс привёл к видимому следу.'),
 E('I have been reading that book / I have read that book. — Какая фраза обычно означает, что книга дочитана?','Have read — готовый результат; have been reading — процесс без гарантии завершения.','Достижение результата.'),
 F('It ___ (rain) since six this morning. — Дождь идёт с шести утра.','has been raining','Since + длительный процесс.'),
 C('Ты всё ещё ждёшь врача с 9 утра. Выбери:', ['I wait since nine.','I was waiting yesterday.','I have been waiting since nine.','I had been waiting before yesterday.'],'I have been waiting since nine.','Продолжается до сейчас.')],
 PaS:[
 F('I ___ (lose) my passport yesterday. — Я потеряла паспорт вчера.','lost','Завершённый прошлый период.'),
 C('«Где ты работала в 2022 году?»',['Where have you worked in 2022?','Where did you work in 2022?','Where had you worked by 2022?','Where are you working in 2022?'],'Where did you work in 2022?','Конкретный прошедший год.'),
 F('She ___ (not/come) three days ago. — Она не пришла три дня назад.','did not come / didn’t come','did not + V.'),
 E('Почему «I have visited Paris yesterday» не подходит?','I visited Paris yesterday.','Завершённый вчерашний период.'),
 F('___ you ___ (call) your mum yesterday? — Ты позвонила маме вчера?','Did ... call','Did + V, без -ed.'),
 O('Устно назови два конкретных события прошлой недели по-английски, используя last week и ago.','Два осмысленных Past Simple предложения.','Завершённая прошлая точка.'),
 E('I used to walk to school / I usually walk to school. — Объясни различие.','Used to — раньше была привычка, обычно больше нет; usually — нынешняя.','Былое vs привычка сейчас.'),
 F('My bicycle ___ (break) on Monday. — Велосипед сломался в понедельник.','broke','Конкретный прошлый день.')],
 PaC:[
 F('At eight yesterday I ___ (do) my homework. — Вчера в 8 я делала уроки.','was doing','Процесс в прошлом.'),
 C('Готовила ужин, когда тебе позвонили: I ___ dinner when she called.',['cooked','was cooking','have cooked','had been cooking'],'was cooking','Длительный фон + короткое событие.'),
 F('The children ___ (not/sleep) when Mum came. — Дети не спали, когда пришла мама.','were not sleeping','Длительный фон.'),
 E('While I was studying, my brother was watching TV. — Почему оба в Continuous?','Одновременные процессы в прошлом.','While указывает на одновременность.'),
 E('I was falling when I hurt my knee / I fell and hurt my knee. — Какая разница смысла?','Процесс падения vs завершённое событие.','Аспект меняет перспективу.'),
 F('What ___ you ___ (do) at six yesterday? — Что ты делала вчера в шесть?','were ... doing','Процесс в определённое время.'),
 O('Опиши голосом, чем занималась вчера в 19:00 и что внезапно прервало процесс. Два времени.','Past Continuous + Past Simple.','Фон и прервавшее событие.'),
 E('Маркеры when и while гарантируют Past Continuous? Когда допустим Past Simple?','Нет, обстоятельство не определяет форму без смысла.','Союз не равен времени.')],
 PaP:[
 F('When I arrived, the train ___ (already/leave). — Я пришла, а поезд уже ушёл.','had already left','Поезд ушёл до её прихода.'),
 C('Ты нашла старый билет после покупки нового:', ['I found the old ticket after I had bought a new one.','I find it after I have bought one.','I had found it after I will buy one.','I have found it last week.'],'I found the old ticket after I had bought a new one.','Два прошлых события, более раннее had bought.'),
 E('I have lost the key / I had lost the key before we left. — Как изменяется точка отсчёта?','Результат сейчас vs потеряла до другого прошлого события.','Настоящее и прошлое.'),
 F('By seven yesterday, we ___ (finish) cleaning. — К семи вчера мы уже закончили уборку.','had finished','Готово к точке в прошлом.'),
 F('Before 2019, he ___ (never/fly). — До 2019 он ни разу не летал.','had never flown','Опыт до прошлой точки.'),
 E('Нужен ли Past Perfect в «She opened the door and sat down»? Когда он необходим?','Нет, порядок уже ясен; нужен для более раннего прошлого.','Не злоупотреблять сложной формой.'),
 O('Устно: опоздала, а друзья уже ушли. Используй had left и arrived. Объясни порядок и переведи.','When I arrived, my friends had left; сначала ушли.','Хронология.'),
 F('We ___ (not/find) our seats when the film started. — Мы ещё не нашли места, когда начался фильм.','had not found','Не завершено до прошлого события.'),
 E('I had already eaten when she arrived / I ate when she arrived. — Это одинаковые значения?','Нет. До её прихода vs во время/после её прихода.','Различие последовательности.'),
 C('Потеря паспорта была ДО вчерашней поездки. Выбери:', ['I have lost it on the journey yesterday.','I had lost it before the trip began.','I will have lost it yesterday.','I am losing it in 2020.'],'I had lost it before the trip began.','Past Perfect для более раннего момента.')],
 PaPC:[
 F('He ___ (wait) for two hours when the doctor arrived. — К приходу врача он ждал уже два часа.','had been waiting','Длительность до другого прошлого события.'),
 C('Она вчера была измучена: весь день готовилась к экзамену.', ['She had been studying all day before she slept.','She has been studying all day yesterday.','She will have studied yesterday.','She studies all day right now.'],'She had been studying all day before she slept.','Был долгий процесс до прошлой точки.'),
 E('He had fixed the bike / He had been fixing the bike before I came. — Гарантирован ли результат?','Had fixed — закончил; had been fixing — работал, не обязательно закончил.','Результат vs процесс.'),
 F('The child ___ (not/sleep) all night before the flight. — Ребёнок не спал всю ночь перед рейсом.','had not been sleeping','Отсутствие длительного сна до прошлой точки.'),
 F('How long ___ she ___ (wait) before the bus came? — Как долго она ждала до автобуса?','had ... been waiting','How long + had been V-ing.'),
 E('Почему «I had been knowing him since childhood» неверно?','I had known him since childhood, know — состояние.','Stative verb.'),
 O('Почему вчера у папы были грязные руки, когда он пришёл из гаража? Построй Past Perfect Continuous.','His hands were dirty because he had been repairing the car.','Процесс раньше, след позже в прошлом.'),
 E('I was working at eight yesterday / I had been working for three hours when she arrived at eight. — Различие?','В 8 процесс vs три часа до 8.','Past Continuous и Past Perfect Continuous.'),
 F('They ___ (stand) in line for an hour before it started raining. — Люди ждали в очереди час до дождя.','had been standing','Длительность до прошедшего события.'),
 C('К концерту ты была мокрой: два часа ждала под дождём.', ['I had waited once.','I had been waiting for two hours.','I am waiting now.','I will be waiting tonight.'],'I had been waiting for two hours.','Длительность и след.')],
 FS:[
 F('I ___ (call) you tomorrow. — Я позвоню тебе завтра.','will call','Обещание.'),
 C('Человек уронил сумку. Ты мгновенно решила помочь:', ['I am helping every day.','I will help you!','I had helped you.','I have helped you yesterday.'],'I will help you!','Решение в момент разговора.'),
 E('I am meeting the dentist tomorrow / I will see a dentist. — Разница?', 'Present Continuous — запись/договорённость; will — решение сейчас/предсказание.','Tomorrow не определяет форму.'),
 F('I ___ (not/tell) anyone your secret. — Обещаю никому не рассказывать твой секрет.','will not tell','Will not + V.'),
 O('Устно пообещай другу помочь с ремонтом на следующей неделе. Одно осмысленное английское предложение.','I will help you with the repair next week.','Обещание и время.'),
 F('___ you ___ (join) us tomorrow? — Ты присоединишься к нам завтра?','Will ... join','Will + субъект + V.'),
 E('She leaves at nine tomorrow / She will probably leave at nine. — Отличие?','Расписание vs прогноз.','Probably не гарантирует уверенность.'),
 C('«Наверное, завтра похолодает» — прогноз:', ['It will probably get colder tomorrow.','It got colder yesterday.','It is getting colder now.','It had got colder before we came.'],'It will probably get colder tomorrow.','Future Simple с probably.')],
 FC:[
 F('At nine tomorrow I ___ (take) my exam. — Завтра в девять я буду сдавать экзамен.','will be taking','Процесс в будущем.'),
 C('Завтра вечером в семь будешь в пути:', ['I will be travelling at seven tomorrow.','I travelled at seven yesterday.','I have travelled many times.','I had travelled before seven.'],'I will be travelling at seven tomorrow.','Процесс в будущую точку.'),
 E('Will you be using the car tomorrow? — Почему такой вопрос может звучать вежливее, чем Will you use the car?', 'Будущая занятость машиной; вопрос о планах без давления.','Future Continuous как мягкая просьба.'),
 F('We ___ (not/use) the kitchen tomorrow evening. — Мы не будем пользоваться кухней завтра вечером.','will not be using','Отрицательный будущий процесс.'),
 O('Устно: что ты будешь делать завтра в это время, а что НЕ будешь делать? Два предложения.', 'will be V-ing / will not be V-ing, конкретный будущий момент.','Процесс, а не готовый результат.'),
 F('We ___ (cook) when our parents arrive. — Мы будем готовить, когда вернутся родители.','will be cooking','Будущий процесс; when + Present Simple.'),
 E('I will be writing at eight / I will have written the essay by eight. — Что изменяется?', 'Буду писать в 8 vs уже закончу к 8.','Процесс vs результат.'),
 C('Вежливо уточни, будет ли друг пользоваться ноутбуком вечером:', ['Will you have finished the laptop?','Will you be using the laptop tonight?','Were you using the laptop yesterday?','Do you use the laptop every day?'],'Will you be using the laptop tonight?','Future Continuous спрашивает о планах.')],
 FP:[
 F('By Friday I ___ (finish) the project. — К пятнице закончу проект.','will have finished','Результат к сроку.'),
 C('Ты приедешь в 20:00, семья уже поужинает:', ['We will be eating at eight.','We will have eaten by eight.','We ate yesterday.','We have been eating now.'],'We will have eaten by eight.','Завершено к восьми.'),
 E('I will finish the essay on Friday / I will have finished it by Friday. — Разница?', 'В пятницу сделаю vs к пятнице уже будет готово.','On vs by.'),
 F('She ___ (not/save) enough money by the end of the year. — К концу года сумма ещё не накопится.','will not have saved','Не будет готово к сроку.'),
 O('Устно пообещай до приезда гостей убрать кухню. Future Perfect и перевод.','I will have cleaned the kitchen by the time the guests arrive.','Будущий дедлайн, готовность.'),
 F('___ you ___ (finish) your homework by the time Mum comes back? — Сделаешь ли уроки до прихода мамы?','Will ... have finished','Future Perfect question.'),
 E('Почему after by the time в «By the time she arrives, I will have left» нет will перед arrives?', 'В придаточном времени для будущего — Present Simple.','Грамматика придаточного времени.'),
 C('К шести подготовка будет закончена:', ['I will have prepared by six.','I have been preparing for six hours yesterday.','I will be preparing until six.','I had prepared before yesterday.'],'I will have prepared by six.','Готовый результат к шести.'),
 F('By next Monday the patient ___ (receive) the test results. — К понедельнику придут результаты анализов.','will have received','Готовый результат в будущем.'),
 E('Чем by Monday отличается от on Monday? Дай конкретный пример.', 'by — не позднее понедельника; on — в понедельник.','Срок vs дата.')],
 FPC:[
 F('By June she ___ (study) English for three years. — К июню будет три года учёбы английского.','will have been studying','Длительность к будущей точке.'),
 C('К восьми папа будет за рулём уже шесть часов:', ['Dad will be driving at eight.','Dad will have been driving for six hours by eight.','Dad had driven by eight yesterday.','Dad has driven for six hours last year.'],'Dad will have been driving for six hours by eight.','Накопленная длительность к восьми.'),
 E('I will have written 10 pages by noon / I will have been writing for three hours by noon. — Разница?', '10 готовых страниц vs 3 часа процесса.','Результат и длительность.'),
 F('By December she ___ (not/work) there for a full year yet. — К декабрю ещё не будет года работы.','will not have been working','Отрицание будущей длительности.'),
 O('Устно: к следующему лету будешь учить какой-то предмет уже несколько лет. Дай Future Perfect Continuous и перевод.','By next summer, I will have been studying ... for ... years.','Срок и длительность.'),
 F('How long ___ you ___ (study) by eight? — Сколько времени будешь учиться к восьми?','will ... have been studying','Future Perfect Continuous вопрос.'),
 E('Почему By Friday I will have been knowing her for a year неверно?', 'Know — состояние; By Friday I will have known her for a year.','Stative verb.'),
 C('К июню мост ремонтируют уже пять лет, и пока не закончили:', ['By June they will have repaired the bridge.','By June they will have been repairing the bridge for five years.','They repaired it last June.','They are repairing it yesterday.'],'By June they will have been repairing the bridge for five years.','Длительность без гарантии результата.'),
 F('By the time you arrive, I ___ (work) for five hours. — К твоему приезду я буду работать уже 5 часов.','will have been working','Длительность до будущего момента.'),
 E('I will be studying at six / I will have studied by six / I will have been studying for 3 hours by six. — Три смысла?', 'Процесс в 6; завершение к 6; длительность процесса к 6.','Будущий аспект.')]
};
const CONTRAST=[
 ['Ключ потерян сейчас и нельзя войти в квартиру. Назови время и объясни.','Present Perfect: I have lost my key; результат ощущается сейчас.'],
 ['Ключ потеряли ДО вчерашнего ремонта замка. Как меняется время?','Past Perfect: I had lost it before the locksmith came. Locksmith (ло́ксмит) — слесарь по замкам.'],
 ['Когда ты пришла к врачу, он уже ушёл. Назови два времени.','The doctor had left when I arrived; ушёл раньше, пришла позже.'],
 ['Врач сообщает: «Я уже отправил анализы». Как ответить с учётом настоящего?','I have already sent the test results; результат к настоящему.'],
 ['Вчера врач отправил результаты ДО звонка пациента. Как объяснить хронологию?','He had sent the results before the patient called; раньше/позже в прошлом.'],
 ['Мы живём здесь с 2020 и до сих пор. Почему возможно Present Perfect Simple?','We have lived here since 2020, состояние/постоянная жизнь.'],
 ['Я пишу диплом уже три часа, он не закончен. Что выбрать?','I have been writing my thesis for three hours; длительность процесса.'],
 ['Я написала три главы диплома. Что выбрать?','I have written three chapters; измеримый завершённый результат.'],
 ['Вчера в шесть писала главу. Какое время и почему?','I was writing at six yesterday; процесс в прошлой точке.'],
 ['К вчерашним шести глава уже была готова. Что выбрать?','I had written the chapter by six yesterday; результат к прошлой точке.'],
 ['К вчерашним шести писала главу уже ТРИ ЧАСА.','I had been writing for three hours by six yesterday; длительность до прошлого момента.'],
 ['Завтра в шесть БУДУ писать главу.','I will be writing at six tomorrow; процесс в будущую точку.'],
 ['К завтрашним шести глава будет готова.','I will have written the chapter by six tomorrow; будущий результат.'],
 ['К завтрашним шести я буду писать уже три часа.','I will have been writing for three hours by six tomorrow; будущая длительность.'],
 ['Почему since 2020 не определяет само по себе Present Perfect Continuous?','Since бывает и с Perfect Simple для состояний: I have known her since 2020.'],
 ['Может ли for three hours сочетаться с Past Perfect Continuous?','Да: I had been waiting for three hours before the bus came; до прошлого момента.'],
 ['Врач звонил дважды вчера. Как сказать на английском?','The doctor called twice yesterday; Past Simple.'],
 ['Врач звонил дважды за ЭТУ неделю, неделя не закончилась.','The doctor has called twice this week; Present Perfect.'],
 ['It has rained / It has been raining. В чём разница?','Perfect Simple — факт/след; Continuous — процесс или длительность дождя.'],
 ['Велосипед уже полностью починен. Почему have been fixing не точно?','Have fixed — готовый результат; have been fixing — работа без гарантии конца.'],
 ['Расставь порядок: приехала полиция, вор ушёл, закрыли магазин.','The thief had left before the police arrived; then they closed the shop.'],
 ['When I have time, I will call you. Почему нет will в придаточном?','После when для будущего в придаточном Present Simple.'],
 ['I am flying tomorrow / I will fly tomorrow. Это оба допустимых варианта?','Да: согласованный план vs обещание/решение/прогноз.'],
 ['У врача ждёшь час и ВСЁ ЕЩЁ ждёшь.','I have been waiting for an hour; до настоящего.'],
 ['Ждала врача час ДО его прихода вчера.','I had been waiting for an hour before he arrived; до другого прошлого события.'],
 ['К завтрашнему визиту уже будет час ожидания.','I will have been waiting for an hour by the time the doctor comes.'],
 ['Почему I have eaten yesterday неправильно?','Yesterday — прошедший завершённый момент; I ate yesterday.'],
 ['Never: I never eat fish / I have never eaten fish. Различие?','Привычка/питание сейчас vs опыт за всю жизнь.'],
 ['Always: I always forget / I am always forgetting. Различие?','Обычная привычка vs раздражение из-за повторяемости.'],
 ['By Friday / on Friday / until Friday. Различие с примером подготовки к экзамену.','By — к пятнице готово; on — событие в пятницу; until — продолжительность до пятницы.'],
 ['Past Perfect без by the time: приведи осмысленный пример.','He was upset because he had lost his ticket.'],
 ['Had she went before I came? Исправь и объясни.','Had she gone before I came? После had нужна V3 — gone.'],
 ['Почему «I have been being here for two hours» неестественно?','Have been here for two hours. Be в значении пребывания не используется так в Continuous.'],
 ['She has cleaned the room / She has been cleaning the room. Что с готовностью комнаты?','Perfect Simple — готова; Continuous — процесс, конец не гарантирован.'],
 ['The train will have left by ten / will be leaving at ten. Отличие?','Уже уедет к десяти vs будет отправляться в десять.'],
 ['«Я уже пообедала» и «Я пообедала вчера в два». Два времени.','I have already had lunch; I had lunch at two yesterday.'],
 ['By the time I arrived, everyone had gone home — какое действие раньше?','Все ушли до моего приезда, Past Perfect vs Past Simple.'],
 ['В письме пишут «I have finished the report». Как понять, ждёт ли адресат отчёт сейчас?','Present Perfect подчёркивает готовый результат на момент письма.'],
 ['Почти весь вечер шёл дождь, когда я приехала вчера. Что подчеркнуть?','It had been raining all evening when I arrived; длительность до прошлого.'],
 ['К концу недели будет известно решение комиссии. Какое Perfect и почему?','By the end of the week, the committee will have made its decision.'],
 ['«Я всё ещё не закончила к вечеру вчера». В чём отличие от «Я ещё не закончила сейчас»?','Past Perfect отрицание до прошлой точки vs Present Perfect отрицание до настоящего.']
];
const ORALS=[
 ['Голосом расскажи про опоздание на транспорт, который уже ушёл. Past Perfect + Past Simple.','Два события, верная хронология, перевод.'],
 ['Устно сравни готовое сегодня домашнее задание с тем, что сделала ДО прихода друга вчера.','Present Perfect vs Past Perfect; результат сейчас и до прошлого.'],
 ['Что уже успела сегодня и чем занимаешься с утра? Два времени и перевод.','Present Perfect vs Present Perfect Continuous.'],
 ['Почему вчера после переезда ты была очень уставшей? Используй Past Perfect Continuous.','Had been moving/packing ... before ..., прошлый длительный процесс.'],
 ['Чем будешь занята завтра в шесть и что закончишь К шести?','Future Continuous vs Future Perfect.'],
 ['К следующему июню будет три года, как учишь английский. Скажи голосом на английском.','By next June I will have been studying English for three years.'],
 ['Чем «смотрела фильм вчера» отличается от «уже смотрела этот фильм раньше»?','Past Simple vs Present Perfect.'],
 ['Составь по примеру для since и for с Perfect Continuous, объясни перевод.','Since + момент, for + длительность, оба уместны.'],
 ['Почему I have known her for years, но I have been working here for years?','Глагол состояния know vs процесс work.'],
 ['Что делала вчера в восемь и что успела сделать ДО восьми?','Past Continuous vs Past Perfect.'],
 ['Расскажи три значения already: к настоящему, к прошлому, к будущему.','Present/Past/Future Perfect с корректной точкой отсчёта.'],
 ['Объясни, почему yesterday не ставят с Present Perfect для конкретного события.','Завершённый прошлый момент → Past Simple.'],
 ['Что обычно делаешь по понедельникам, но временно не делаешь на этой неделе?','Present Simple vs Present Continuous.'],
 ['Ты ведёшь машину сейчас, а вчера тебя отвлёк звонок. Два времени.','Present Continuous; Past Continuous + Past Simple.'],
 ['К понедельнику будут готовы четыре страницы отчёта. Скажи Future Perfect и перевод.','I will have written four pages by Monday.'],
 ['К понедельнику будешь писать отчёт уже неделю, но он может быть не закончен.','Future Perfect Continuous; длительность до будущей точки.'],
 ['Докажи на примере, что when не всегда Past Simple.','When с Past Continuous либо Present Simple для будущего.'],
 ['Ты завтра встречаешься с подругой по договорённости. В чём отличие от will?','Present Continuous договорённость; will обещание/решение.'],
 ['Своими словами сравни Present Perfect, Past Perfect, Future Perfect, Present Perfect Continuous.','Точка отсчёта сейчас/прошлое/будущее; результат vs процесс.'],
 ['Пациент ждёт полчаса сейчас, вчера час до приёма и завтра к 14:00 два часа. Три формы.','have been waiting / had been waiting / will have been waiting.'],
 ['Не успела вчера к восьми vs не успею завтра к восьми.','had not finished vs will not have finished.'],
 ['Составь предложения с by и when о школьном экзамене и объясни, где дедлайн.','By + срок; when + событие, Perfect при результате к точке.'],
 ['Пример из уборки квартиры: всё убрано vs убирала долго и устала.','Have cleaned vs have been cleaning, результат vs процесс.'],
 ['Мини-рассказ из трёх осмысленных предложений с Present Perfect, Past Perfect и Past Simple.','Связная хронология, смысл и грамматика.'],
 ['Голосом расскажи, как изменится «Моя мама поехала домой» при акценте «уже дома» vs «была дома до моего звонка вчера».','Present Perfect: has gone/has come home по контексту; Past Perfect: had arrived home before I called.'],
 ['Объясни голосом, почему «By 2030, I will have been living here for ten years» не обещает, что переезд закончится.','Будущая накопленная длительность, не обязательно завершение.']
];
export function buildTenseMarkerQuestions(){
 const result=[];let next=0;
 function add(q,source,extra={}){
  result.push({id:'TM'+String(++next).padStart(3,'0'),...q,...extra,source});
 }
 for(const id of ['PP','PaP','PPC','PaPC','FP','FPC','PS','PC','PaS','PaC','FS','FC']){
  const t=MARKER_TENSES.find(x=>x.id===id);
  for(const q of SCENARIOS[id])add(q,'real-life',{tense:t.name,group:t.group});
 }
 CONTRAST.forEach(a=>add(E(a[0],a[1],'Точки отсчёта, длительность, результат, смысл хронологии.'),'contrast',{tense:'Perfect / Continuous',group:'Сравнения'}));
 ORALS.forEach(a=>add(O(a[0],a[1],'Ответить осмысленно, перевести примеры и грамматически обосновать.'),'oral',{tense:'Смешанные времена',group:'Устные объяснения'}));
 for(const t of MARKER_TENSES){
  const options=MARKER_TENSES.filter(x=>x.group===t.group).map(x=>x.name);
  for(const example of t.ex){
   const text=example[1].replace(/<\/?b>/gu,'');
   add(C('Определи время и смысл маркера:\n'+text+'\n↳ '+example[2],options,t.name,
    t.name+': '+t.meaning+'. Маркер лишь подсказка, грамматика и контекст решают.'),'recognition',{tense:t.name,group:t.group});
  }
 }
 return result;
}
export const MARKER_QUESTIONS=buildTenseMarkerQuestions();
export const MARKER_QUESTION_COUNTS=Object.freeze({
 all:MARKER_QUESTIONS.length,
 deep:MARKER_QUESTIONS.filter(x=>x.source==='real-life').length,
 contrasts:MARKER_QUESTIONS.filter(x=>x.source==='contrast').length,
 oral:MARKER_QUESTIONS.filter(x=>x.type==='oral').length,
 choices:MARKER_QUESTIONS.filter(x=>x.type==='choice').length,
 perfect:MARKER_QUESTIONS.filter(x=>/Perfect/i.test(x.tense||'')||x.source==='contrast').length,
});
