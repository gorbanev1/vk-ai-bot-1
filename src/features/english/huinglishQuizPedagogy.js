// Keep legacy distractors readable; only unambiguous ones enter new questions.
export const AMBIGUOUS_NEAR_CHOICES = new Set([
    "I'm gonna head on.", 'Read a room.', "It's giving main characters energy.",
]);
const VALID_NEAR = new Set([
    "What's down?", "I'm gonna head in.", "I'm gonna head on.",
    'You going in tonight?', "What's on the cover?", 'That checks in.',
    "That's mild!", 'High-key, I like it.', "I'm locked out.",
    'Brekkies.', 'Barbies.', 'No caps!', 'Read a room.',
    "This song's a banker!", "What's on the move?",
    "I see where you're coming to.", "I've got your front.",
    'Reading the room!', 'No pressures.',
]);
export const validNearChoice = item => VALID_NEAR.has(item.answer);
export function contextMismatch(right,picked) {
    if(right.answer==="How've you been?"&&picked.answer==="It's been a minute.")
        return '💡 Почему не подходит: «'+picked.meaning+'» — естественный ответ на Long time no see! Но это констатация, а не вопрос о делах. Задание: '+right.scene+'.';
    if(right.answer==="It's been a minute."&&picked.answer==="How've you been?")
        return '💡 Почему не подходит: «'+picked.meaning+'» уместно при встрече, но спрашивает о делах. Здесь нужно отметить долгую разлуку: '+right.scene+'.';
    return '💡 Почему не подходит: «'+picked.meaning+'» выражает другую мысль. Задание здесь: '+right.scene+'.';
}
// Phrase-specific grammar beats a diff of words: inverted questions, embedded
// clauses, nouns and particles cannot share a subject-then-verb explanation.
const rows = String.raw`
What's up?|В приветственном вопросе what’s — это what is; up стоит после него. Это устойчивое «что нового?», порядок обычного утверждения сюда не переносится.
You good?|Это разговорное сокращение вопроса Are you good? С you согласуется are; после прилагательного good второй глагол is не нужен.
I'm gonna head out.|После gonna нужен глагол head без -ing; out следует за head и обозначает уход. Форма am уже входит в I’m.
Lemme know.|Lemme — разговорное let me. После let + me ставят know без to и -ing: просьба дать знать, а не описание процесса.
You alright, mate?|Полная форма — Are you alright? В разговоре are может опускаться; mate — обращение в конце. Is с you здесь не согласуется.
Fancy a cuppa?|Fancy здесь значит «хочешь?», а cuppa — существительное «чашка чая». Перед одним предметом ставят a, после fancy не требуется to.
I'm knackered.|Knackered описывает усталость: после I нужна связка am, затем прилагательное с -ed. Форма knacker не заменяет это состояние.
How ya going, mate?|Это австралийский вопрос о делах: how + (are) you/ya + going. В разговоре are опускают; прошедшее went не подходит к такой форме вопроса.
No worries.|No определяет существительное worries во множественном числе. Not — отрицательная частица, worried — прилагательное; они не заменяют эту конструкцию.
See ya this arvo.|Ya — разговорное you и стоит после see. This arvo означает «сегодня днём»: перед this не добавляют at, this согласуется с одним периодом.
No cap!|Cap в этом сленге означает ложь. Отсутствие лжи выражает no перед существительным; not и множественное caps не дают нужной идиомы.
I'm finna dip.|Finna — разговорное намерение, после него dip без to и -ing. Не ставь глагол действия перед finna: поменяется структура выражения.
He be working nights.|Это habitual be в AAVE: he + неизменяемое be + working. Так говорят о регулярном действии; не добавляют is перед be или -s к working.
Brekkie.|Brekkie — разговорное существительное «завтрак». Здесь называют один завтрак, а не несколько; окончание -ing не превращает его в нужную реплику.
Barbie.|Barbie — австралийское существительное «барбекю». В задании одно барбекю; это не действие с -ing и не несколько мероприятий.
You going out tonight?|Это сокращённое Are you going out tonight? После you следует going, затем направление out; to перед наречием out не нужно.
I'm down.|Здесь down — состояние согласия «я за»: после I требуется am. Это не глагол действия, поэтому не добавляй -ing и не переставляй down перед I’m.
What's the cover?|What’s раскрывается как what is. В прямом вопросе is идёт перед the cover; cover здесь входная плата, а не изображение на обложке.
This place is packed!|Подлежащее this place в единственном числе: затем is и прилагательное packed. Форма pack без -ed не выражает состояние «битком».
Can I get some water?|Вопрос строится can + I + get. После can глагол без to и -ing; some определяет количество воды, а не является предлогом.
This song's a banger!|Song’s здесь song is; a banger — существительное «хит». Перед banger нужен a. Слова banging и banker имеют другую форму или смысл.
Wanna dance?|Wanna сокращает want to; далее идёт dance без дополнительного to и -ing. Приглашение начинается с wanna, а не с переставленного dance.
Let's bounce.|Let’s означает let us и требует глагола bounce в начальной форме. Ни прошедшее -ed, ни -ing после let’s здесь не подходят.
Fancy a drink?|Fancy в этом вопросе сочетается с существительным a drink. Артикль a относится к одной порции, поэтому не сочетается с drinks во множественном числе.
Keen for a dance?|For связывает keen с существительным a dance. Вариант keen to тоже возможен, но после to нужен глагол dance без артикля a.
I'm not gonna lie.|После gonna ставят lie без -ing; not находится перед gonna. Предлог on не нужен: речь о намерении говорить честно, а не о месте действия.
That checks out.|Здесь check out — «подтверждаться, сходиться». С that в настоящем утверждении глагол получает -s, а частица out идёт после checks.
Low-key, I like it.|Low-key задаёт сдержанный оттенок. Далее обычный порядок I + like + it; с I глагол like не получает окончания третьего лица -s.
That's wild!|That’s — это that is; wild является прилагательным после связки. Второе is не нужно, а are не согласуется с единственным that.
I see where you're coming from.|После see идёт вложенная часть where + you are + coming + from. Это не отдельный вопрос: сохраняем you’re перед coming, from — в конце оборота.
I'm not sold on it.|Sold on означает «убеждён в этом»; not отрицает состояние после am. Selling — процесс продажи, а частица in не заменяет on в этом значении.
That's a stretch.|Stretch здесь исчисляемое существительное «натяжка», поэтому перед ним a. Stretching обозначает другое действие или форму, не эту оценку.
I'm on the fence.|Это идиома о нерешительности: on + the fence. The относится к fence, а a не сочетается с множественным fences.
Let's play it by ear.|После let’s идёт play без -ed. Местоимение it ставят сразу после play, а by ear — устойчивый оборот «по обстоятельствам», не on/in ear.
It slipped my mind.|О забытом деле говорят в прошлом: slipped. После глагола идёт my mind без предлога on; перестановка mind перед slipped ломает обычную конструкцию.
My bad. That's on me.|My bad — самостоятельное признание ошибки; my стоит перед bad. On me выражает ответственность, а не нахождение in me или направление at me.
I'm locked in.|Locked in здесь состояние полной сосредоточенности: am + locked + in. Неправильной формы lockeding нет; частица идёт после locked.
I can't be bothered.|После can’t требуется базовая форма be, затем bothered. Being или отсутствие be не подходят к этому модальному обороту.
Thanks heaps!|Thanks — благодарность, heaps усиливает её до «огромное спасибо». Слова остаются в этом порядке; heap или thank без -s не образуют ту же реплику.
I'm all set.|Am — связка после I; all усиливает состояние set. Set здесь не глагол третьего лица и не получает -s; all ставят после I’m.
I feel you.|Feel в значении «понимаю» — смысловой глагол: I + feel + you. С I не добавляют -s; для формы feeling потребовалась бы другая конструкция.
Go figure.|Это повелительная идиома с базовыми go и figure. Формы going или figures не создают нужного приглашения «попробуй объясни».
You do you.|Первое you — подлежащее 2-го лица (ты/вы). В Present Simple с you смысловой глагол do не получает -s; форма does относится к he/she/it — 3-му лицу единственного числа. Второе you — самостоятельное местоимение-дополнение; your — притяжательное слово перед существительным, а не замена дополнения.
Can I take a rain check?|Вопрос: can + I + take; после модального глагола нет -ing. A rain check — целое существительное, стоящее после take, а не перед ним.
He flaked on me.|О несостоявшейся встрече говорят flaked в прошлом, затем on + me. Предлог относится к человеку после глагола, не ставится перед flaked.
She ghosted me.|Ghost в этом смысле принимает me напрямую, без at. Прошедшее действие выражает ghosted; для ghosting нужна связка was/is и другой временной смысл.
That's a rip-off!|Rip-off — исчисляемое существительное «обдираловка», перед ним нужен артикль a. Части составного слова и артикль нельзя переставлять местами.
It's not that deep.|Not отрицает оценку после is; that усиливает прилагательное deep («настолько»). No обычно определяет существительное, а не такую оценку.
I'm just messing with you.|Процесс: am + messing; just ставят перед messing, затем with + you. Без -ing после am и с другой частицей нужное «подкалываю» не получается.
It's giving main character energy.|Это сленговая конструкция is + giving. Main character описывает тип energy; определение идёт после giving целиком, без перестановки его частей.
That track slaps!|В сленге slap — «мощно звучать»: с единственным track нужен slaps. Для slapping потребовалось бы is; частица on здесь не нужна.
I'm gutted.|Gutted описывает сильное огорчение: I + am + gutted. Gut — другое слово; без am или с переставленной связкой эта реплика не строится.
That's dodgy.|Dodgy — прилагательное «подозрительный». После единственного that нужна связка is; dodge — глагол и не заменяет эту оценку.
Look who it is!|После look идёт вложенная конструкция who + it + is. Это восклицание, не вопрос Who is it?; who’s добавило бы лишнее is.
It's been a minute.|It’s здесь сокращает it has: после has нужна форма been, затем a minute. Being не заменяет been, а без has время Perfect не образуется.
How've you been?|В прямом вопросе have стоит ПЕРЕД you: how + have + you + been. Have сокращается до ’ve после how; после have нужна форма been, не being.
We should catch up.|После should ставят catch без to и -ing. Частица up идёт после catch и задаёт значение «пообщаться о новостях».
Hit me up.|В этом фразовом глаголе местоимение me обязательно между hit и up. Другая частица может дать другое действие, но не просьбу связаться.
I'll swing by.|После will, сокращённого в I’ll, нужен swing без -ing. By стоит после swing и означает короткий визит; перестановка ломает фразовый глагол.
Wanna tag along?|После wanna нужен tag без -ing; along следует за tag. Это приглашение присоединиться, направление off или through не даёт того же смысла.
No pressure.|Pressure здесь неисчисляемое существительное про давление обязательств: перед ним no. Not и перестановка no в конец не дают обычной успокаивающей реплики.
I'm good either way.|После I нужна связка am и оценка good; either way ставят после неё. После either в этом сочетании way в единственном числе.
You crack me up.|С you глагол crack без -s. Местоимение me ставят между crack и up; именно up задаёт значение «смешить», а не буквальное действие.
Don't make it weird.|После don’t глагол make без -s и -ing, затем дополнение it и оценка weird. Менять местами it и weird здесь нельзя.
Read the room.|Это совет: базовое read, затем the + room. Reading — описание действия или заголовок, не такая форма повеления.
I've got your back.|I’ve здесь I have; после have нужна форма got. Your определяет существительное back и стоит перед ним; getting вместо got требует другой конструкции.
My treat.|My — притяжательное определение перед существительным treat («угощение за мой счёт»). Mine употребляется самостоятельно, treating — другая форма.
You had to be there.|Had to выражает необходимость в прошлом; to обязательно перед be. Has не согласуется с you и не обозначает нужное прошлое.
What's the move?|В прямом вопросе what’s раскрывается как what is: is идёт перед the move. Move в единственном числе, поэтому are здесь не подходит.
Give me a shout.|После give идёт получатель me, затем a shout — существительное «весточка». A здесь артикль, не предлог; shouting и shut не заменяют нужное слово.
Good on ya!|Это австралийское одобрение: good, затем on, затем ya (you). Замена on на at/in или перестановка слов не даёт этой устойчивой реплики.
`;
export const HUINGLISH_CONSTRUCTION_HINTS = new Map(rows.trim().split('\n').map(line=>line.split('|')));
