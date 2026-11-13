import { AMBIGUOUS_NEAR_CHOICES } from './huinglishQuizPedagogy.js';
import { HUINGLISH_QUIZ_EXTRA_CHOICES } from './huinglishQuizOtherChoices.js';
import { HUINGLISH_QUIZ_NEAR_BY_ANSWER } from './huinglishQuizNearChoices.js';

// Natural, correct English NOT taught in the course. Each one contrasts with a
// specific situation (price vs availability, asking to leave vs locating an exit,
// who will call whom, etc.), never with a random unrelated everyday topic.
const CONTEXTUAL_EXTRA=Object.freeze({
    "I'm gonna head out.":"Where's the exit?",
    "Lemme know.":"I'll call you tomorrow.",
    "See ya this arvo.":"I'll call you tomorrow.",
    "You going out tonight?":"I booked a table.",
    "What's the cover?":"The tickets sold out.",
    "This place is packed!":"Is this seat taken?",
    "Let's bounce.":"Where's the exit?",
    "It slipped my mind.":"I left my keys at home.",
    "Can I take a rain check?":"It's raining again.",
    "That's a rip-off!":"That looks expensive.",
    "Hit me up.":"I'll call you tomorrow.",
    "I'll swing by.":"I ordered a taxi.",
    "What's the move?":"Where's the exit?",
});

// Learned phrases only when they play a contrasting role in the same type of
// dialogue. Do not pair truly synonymous answers such as "Wanna dance?" and
// "Keen for a dance?", or "Hit me up." and "Give me a shout.".
const CONTEXTUAL_LEARNED=Object.freeze({
    "You good?":"No worries.","Brekkie.":"Barbie.","Barbie.":"Brekkie.",
    "You going out tonight?":"What's the cover?",
    "I'm down.":"I'm on the fence.","What's the cover?":"This place is packed!",
    "This place is packed!":"What's the cover?",
    "Can I get some water?":"Fancy a drink?",
    "This song's a banger!":"Wanna dance?","Wanna dance?":"This song's a banger!",
    "Let's bounce.":"You going out tonight?",
    "I'm not gonna lie.":"I'm not sold on it.",
    "That checks out.":"That's a stretch.","Low-key, I like it.":"I'm not sold on it.",
    "That's wild!":"That checks out.",
    "I'm not sold on it.":"I'm down.","That's a stretch.":"That checks out.",
    "I'm on the fence.":"I'm down.","Let's play it by ear.":"I'm on the fence.",
    "My bad. That's on me.":"Go figure.","I'm locked in.":"I can't be bothered.",
    "I can't be bothered.":"I'm locked in.","Thanks heaps!":"Good on ya!",
    "I'm all set.":"Can I get some water?","I feel you.":"You do you.",
    "You do you.":"I feel you.","Can I take a rain check?":"I'm down.",
    "He flaked on me.":"She ghosted me.","She ghosted me.":"He flaked on me.",
    "It's not that deep.":"I feel you.","I'm gutted.":"I'm knackered.",
    "That's dodgy.":"That's a stretch.",
    "How've you been?":"It's been a minute.","It's been a minute.":"How've you been?",
    "We should catch up.":"Wanna tag along?","Wanna tag along?":"We should catch up.",
    "I'm good either way.":"I'm on the fence.",
    "You crack me up.":"That's wild!","Read the room.":"Don't make it weird.",
    "My treat.":"Thanks heaps!","What's the move?":"Let's play it by ear.",
    "Good on ya!":"Thanks heaps!",
});
const EXTRA_BY_ANSWER=new Map(HUINGLISH_QUIZ_EXTRA_CHOICES.map(item=>[item.answer,item]));
const CONFUSABLE_GROUPS=[
    ["What's up?",'How ya going, mate?', "How've you been?"],
    ['You good?','You alright, mate?'],
    ["I'm gonna head out.","I'm finna dip.","Let's bounce."],
    ['Lemme know.','Hit me up.','Give me a shout.'],
    ['Wanna dance?','Keen for a dance?'],
    ["This song's a banger!",'That track slaps!'],
    ['Fancy a cuppa?','Fancy a drink?'],
    ["I'm on the fence.","I'm not sold on it."],
    ['No cap!',"I'm not gonna lie."],
];
const confusable=(a,b)=>CONFUSABLE_GROUPS.some(group=>group.includes(a.answer)&&group.includes(b.answer));

export function buildHuinglishQuizOptions(chosen,available,seed=0) {
    const near=(HUINGLISH_QUIZ_NEAR_BY_ANSWER.get(chosen.answer)||[]).filter(item=>!AMBIGUOUS_NEAR_CHOICES.has(item.answer));
    if(near.length<2)throw Error('Missing curated grammar traps for '+chosen.answer);
    // 2–4 near misses; two one-word abbreviations need a third choice
    // from the studied course, everything else usually has three.
    const nearCount=near.length===4&&seed%3===0?4:Math.min(near.length,3);
    const shift=seed%near.length;
    const distractors=[...near.slice(shift),...near.slice(0,shift)].slice(0,nearCount);
    const add=item=>{
        if(!item||distractors.length>=5||item.answer===chosen.answer||
            distractors.some(x=>x.answer.toLowerCase()===item.answer.toLowerCase())||
            confusable(item,chosen))return;
        distractors.push(item);
    };
    const learned=available.find(item=>item.answer===CONTEXTUAL_LEARNED[chosen.answer] &&
        item.meaning!==chosen.meaning && item.id!==chosen.id);
    // When four grammar traps fit, leave the optional learned choice out.
    if(nearCount<4)add(learned);
    add(EXTRA_BY_ANSWER.get(CONTEXTUAL_EXTRA[chosen.answer]));
    if(distractors.length<3) {
        const fallback=available.find(item=>item.id!==chosen.id &&
            item.answer!==chosen.answer && item.meaning!==chosen.meaning &&
            !confusable(item,chosen) && !distractors.some(x=>x.answer===item.answer));
        add(fallback);
    }
    if(distractors.length<3)throw Error('Not enough safe options for '+chosen.answer);
    return [chosen,...distractors]; // caller shuffles and persists IDs
}

export const HUINGLISH_QUIZ_CONTEXTUAL_EXTRA=CONTEXTUAL_EXTRA;
export const HUINGLISH_QUIZ_CONTEXTUAL_LEARNED=CONTEXTUAL_LEARNED;
