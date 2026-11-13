import { explainHuinglishNearChoice } from './huinglishQuizNearExplanations.js';

// Reviewed, deliberately INCORRECT near-misses for the 71 unique expressions
// taught in lessons 1–5 and 7 (lesson 6 reuses the same phrases).
// p = wrong particle/preposition; o = wrong word order;
// g = wrong grammatical form; s = meaning changed by a similar word.
// These must never be considered acceptable alternative answers.
// Delimiter: original | kind:incorrect option | ...
const rows = String.raw`
What's up?|p:What's down?|o:Up what's?|g:What up is?
You good?|g:You is good?|o:Good you?|g:You are good is?
I'm gonna head out.|p:I'm gonna head in.|o:I'm gonna out head.|g:I'm gonna heading out.|p:I'm gonna head on.
Lemme know.|g:Lemme knowing.|o:Know lemme.|g:Lemme to know.
You alright, mate?|g:You is alright, mate?|o:Alright you, mate?|g:You are alright is, mate?
Fancy a cuppa?|g:Fancy to cuppa?|o:A cuppa fancy?|g:Fancy a cuppas?
I'm knackered.|g:I'm knacker.|o:Knackered I'm.|g:I knackered.
How ya going, mate?|o:How going ya, mate?|g:How ya went, mate?|g:How is ya going, mate?
No worries.|g:Not worries.|o:Worries no.|g:No worried.
See ya this arvo.|p:See ya at this arvo.|g:See ya these arvo.|o:See this ya arvo.
No cap!|g:Not cap!|o:Cap no!|g:No caps!
I'm finna dip.|g:I'm finna dipping.|o:I'm dip finna.|g:I'm finna to dip.
He be working nights.|g:He be works nights.|g:He is be working nights.|o:He working be nights.
Brekkie.|g:Brekkies.|g:Brekkieing.
Barbie.|g:Barbies.|g:Barbieing.
You going out tonight?|o:You out going tonight?|g:You going to out tonight?|p:You going in tonight?
I'm down.|g:I down.|o:Down I'm.|g:I'm downing.
What's the cover?|p:What's on the cover?|o:The cover what's?|g:What the cover is?
This place is packed!|g:This place are packed!|o:This packed is place!|g:This place is pack!
Can I get some water?|p:Can I get on water?|o:Can get I some water?|g:Can I getting some water?
This song's a banger!|g:This song's a banging!|o:This a song's banger!|s:This song's a banker!
Wanna dance?|g:Wanna dancing?|o:Dance wanna?|g:Wanna to dance?
Let's bounce.|g:Let's bounced.|o:Bounce let's.|g:Let's bouncing.
Fancy a drink?|g:Fancy to drink?|o:A drink fancy?|g:Fancy a drinks?
Keen for a dance?|p:Keen to a dance?|o:For a dance keen?|g:Keen for dancing a?
I'm not gonna lie.|g:I'm not gonna lying.|o:I'm not lie gonna.|p:I'm not gonna on lie.
That checks out.|p:That checks in.|g:That check out.|o:That out checks.
Low-key, I like it.|s:High-key, I like it.|o:Low-key, like I it.|g:Low-key, I likes it.
That's wild!|s:That's mild!|o:That's wild is!|g:That are wild!
I see where you're coming from.|p:I see where you're coming to.|o:I see where from you're coming.|g:I seeing where you're coming from.
I'm not sold on it.|p:I'm not sold in it.|o:I'm on sold not it.|g:I'm not selling on it.
That's a stretch.|g:That's stretch.|o:That's stretch a.|g:That's a stretching.
I'm on the fence.|p:I'm in the fence.|o:I'm the fence on.|g:I'm on a fences.
Let's play it by ear.|p:Let's play it on ear.|o:Let's play by it ear.|p:Let's play it in ear.|g:Let's played it by ear.
It slipped my mind.|p:It slipped on my mind.|o:It my mind slipped.|g:It slip my mind.
My bad. That's on me.|p:My bad. That's in me.|o:Bad my. That's on me.|g:My bad. That's at me.
I'm locked in.|p:I'm locked out.|o:I'm in locked.|g:I'm lockeding in.
I can't be bothered.|g:I can't being bothered.|o:I be can't bothered.|g:I can't bothered.
Thanks heaps!|g:Thanks heap!|o:Heaps thanks!|g:Thank heaps!
I'm all set.|g:I'm all sets.|o:All I'm set.|g:I all set am.
I feel you.|g:I feeling you.|o:You feel I.|g:I feels you.
Go figure.|g:Going figure.|o:Figure go.|g:Go figures.
You do you.|g:You does you.|o:Do you you.|g:You do your.
Can I take a rain check?|p:Can I take a rain out?|o:Can I a rain check take?|g:Can I taking a rain check?|p:Can I take a rain in?
He flaked on me.|p:He flaked in me.|o:He on me flaked.|g:He flake on me.
She ghosted me.|o:She me ghosted.|g:She ghosting me.|p:She ghosted at me.
That's a rip-off!|p:That's a rip-in!|g:That's rip-off!|o:That's off-rip a!
It's not that deep.|p:It's not on deep.|o:It's that not deep.|g:It's no that deep.
I'm just messing with you.|p:I'm just messing on you.|o:I'm with messing just you.|g:I'm just mess with you.
It's giving main character energy.|g:It's give main character energy.|o:It's main giving character energy.|g:It's giving main characters energy.
That track slaps!|g:That track slapping!|o:That slaps track!|p:That track slaps on!
I'm gutted.|g:I'm gut.|o:Gutted I'm.|g:I gutted.
That's dodgy.|g:That's dodge.|o:Dodgy that's.|g:That are dodgy.
Look who it is!|o:Look it who is!|g:Look who's it is!|o:Who look it is!
It's been a minute.|g:It's being a minute.|o:It's a minute been.|g:It been a minute.
How've you been?|o:How you have been?|g:How've you being?|o:How been you've?
We should catch up.|p:We should catch down.|o:We should up catch.|g:We should catching up.|p:We should catch off.
Hit me up.|p:Hit me down.|o:Hit up me.|p:Hit me off.
I'll swing by.|p:I'll swing at.|o:I'll by swing.|g:I'll swinging by.|p:I'll swing on.
Wanna tag along?|p:Wanna tag off?|o:Wanna along tag?|g:Wanna tagging along?|p:Wanna tag through?
No pressure.|g:No pressures.|o:Pressure no.|g:Not pressure.
I'm good either way.|g:I'm good either ways.|o:I'm either good way.|g:I good either way.
You crack me up.|p:You crack me down.|o:You crack up me.|g:You cracks me up.|p:You crack me on.
Don't make it weird.|g:Don't making it weird.|o:Don't make weird it.|g:Don't makes it weird.
Read the room.|g:Reading the room!|o:Read room the.|g:Read a room.
I've got your back.|p:I've got your front.|o:I've your back got.|g:I've getting your back.
My treat.|g:Mine treat.|o:Treat my.|g:My treating.
You had to be there.|g:You had be there.|o:You to had be there.|g:You has to be there.
What's the move?|p:What's on the move?|o:What the move is?|g:What are the move?
Give me a shout.|p:Give me on shout.|o:Give a shout me.|g:Give me a shouting.|s:Give me a shut.
Good on ya!|p:Good in ya!|o:On ya good!|g:Good at ya!
`;
const descriptions=Object.freeze({
    p:'Заменён предлог или частица: выражение меняет смысл либо перестаёт быть правильным.',
    o:'Нарушен порядок слов: так эту конструкцию не строят.',
    g:'Искажена грамматическая форма или согласование.',
    s:'Похожее слово изменило смысл выражения.',
});
const bySource=new Map();
let next=1;
export const HUINGLISH_QUIZ_NEAR_CHOICES=Object.freeze(rows.trim().split('\n').map(line=>{
    const [sourceAnswer,...choices]=line.split('|');
    if(!sourceAnswer||choices.length<2||bySource.has(sourceAnswer)) throw Error('Invalid near-choice row: '+line);
    const parsed=choices.map(raw=>{
        const kind=raw[0],answer=raw.slice(2);
        if(raw[1]!==':'||!descriptions[kind]||!answer||answer.length>40||answer===sourceAnswer)
            throw Error('Invalid near-choice: '+raw+' for '+sourceAnswer);
        return Object.freeze({id:'near:'+next++,answer,sourceAnswer,kind,trapExplanation:explainHuinglishNearChoice(sourceAnswer,answer,kind),
            meaning:'Неправильная конструкция (учебная ловушка)',
            usage:'эта фраза здесь содержит ошибку'});
    });
    if(new Set(parsed.map(x=>x.answer.toLowerCase())).size!==parsed.length)
        throw Error('Duplicate near-choice: '+sourceAnswer);
    bySource.set(sourceAnswer,Object.freeze(parsed));
    return parsed;
}).flat());
export const HUINGLISH_QUIZ_NEAR_BY_ANSWER=bySource;
