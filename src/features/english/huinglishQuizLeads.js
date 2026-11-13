// Short English dialogue starters, independently curated for each expression.
// The real question is a two-line exchange with a missing reply, not just
// an isolated translation word or a grammar-definition link.
const source = String.raw`
What's up?|Hey there!
You good?|I feel terrible today.
I'm gonna head out.|It's getting late.
Lemme know.|I haven't decided yet.
You alright, mate?|I just slipped on the stairs.
Fancy a cuppa?|It's cold out here.
I'm knackered.|How was your long shift?
How ya going, mate?|G'day!
No worries.|Thanks for your help!
See ya this arvo.|Let's meet after lunch.
No cap!|Are you actually serious?
I'm finna dip.|Are you staying here?
He be working nights.|Does he work nights regularly?
Brekkie.|What do Aussies call breakfast?
Barbie.|What do Aussies call a barbecue?
You going out tonight?|Any plans for this evening?
I'm down.|Want to join us at the club?
What's the cover?|This club charges an entrance fee.
This place is packed!|Look at how many people are here!
Can I get some water?|What would you like to drink?
This song's a banger!|What do you think of this song?
Wanna dance?|The dance floor is right there.
Let's bounce.|This party is getting dull.
Fancy a drink?|I'm feeling thirsty.
Keen for a dance?|I love this music.
I'm not gonna lie.|Please be honest with me.
That checks out.|The timetable matches the story.
Low-key, I like it.|Do you secretly like the idea?
That's wild!|I met a celebrity on the train!
I see where you're coming from.|I think the price is too high.
I'm not sold on it.|Do those arguments convince you?
That's a stretch.|One mistake means he's always lying!
I'm on the fence.|Which of the two would you choose?
Let's play it by ear.|Should we plan every minute?
It slipped my mind.|Why did you forget to call?
My bad. That's on me.|Who forgot to bring the tickets?
I'm locked in.|Are you ready to focus?
I can't be bothered.|Want to do this boring paperwork?
Thanks heaps!|I brought the book you needed.
I'm all set.|Would you like another coffee?
I feel you.|I've had such a difficult week.
Go figure.|He showed up late again!
You do you.|I want to wear this unusual outfit.
Can I take a rain check?|Can we have dinner tonight?
He flaked on me.|Where's Max? He promised to come.
She ghosted me.|Has she answered your messages?
That's a rip-off!|A bottle of water costs twenty dollars.
It's not that deep.|I have analyzed that joke for hours.
I'm just messing with you.|Wait, was that an insult?
It's giving main character energy.|What do you think of her look?
That track slaps!|Do you like this track?
I'm gutted.|Sadly, you didn't get the job.
That's dodgy.|This offer has no details or contacts.
Look who it is!|Hey, do you still remember me?
It's been a minute.|We last met years ago.
How've you been?|Long time no see!
We should catch up.|We haven't talked in ages.
Hit me up.|I still don't know my schedule.
I'll swing by.|Can you stop at my place briefly?
Wanna tag along?|I'm going to the market with friends.
No pressure.|What if I can't come along?
I'm good either way.|Coffee or tea? Either works.
You crack me up.|Here's another silly joke for you.
Don't make it weird.|Should I tell everyone our secret?
Read the room.|Why isn't anyone laughing?
I've got your back.|I'm nervous about going alone.
My treat.|Should we split the bill?
You had to be there.|I don't understand why it was funny.
What's the move?|The concert just ended.
Give me a shout.|I'll tell you when I'm free.
Good on ya!|I helped an elderly neighbor today.
`;
export const HUINGLISH_QUIZ_LEADS = Object.freeze(Object.fromEntries(
    source.trim().split('\n').filter(Boolean).map((row) => {
        const pivot = row.indexOf('|');
        if (pivot <= 0) throw new Error('Invalid quiz lead: ' + row);
        return [row.slice(0, pivot), row.slice(pivot + 1)];
    })
));
