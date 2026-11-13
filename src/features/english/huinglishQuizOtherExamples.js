const rows=String.raw`I missed my bus.|I missed my bus this morning.|Я сегодня утром пропустил автобус.|Sorry I'm late, I missed my bus.|Прости за опоздание, я пропустил автобус.
It's raining again.|Take an umbrella, it's raining again.|Возьми зонт, опять дождь.|We can't play outside. It's raining again.|На улице не поиграешь. Опять дождь.
The shop is closed.|We can't buy bread, the shop is closed.|Не купим хлеб: магазин закрыт.|The shop is closed on Sundays.|По воскресеньям магазин не работает.
I'll call you tomorrow.|I'm busy now. I'll call you tomorrow.|Сейчас занят. Позвоню завтра.|I'll call you tomorrow after work.|Позвоню тебе завтра после работы.
I left my keys at home.|I left my keys at home and can't get in.|Оставил ключи дома и не могу попасть внутрь.|Can you open the door? I left my keys at home.|Откроешь дверь? Я оставил ключи дома.
The train is delayed.|The train is delayed by twenty minutes.|Поезд задерживается на двадцать минут.|I'm still at the station. The train is delayed.|Я пока на вокзале, поезд задерживается.
I need a charger.|My phone is almost dead. I need a charger.|Телефон почти сел. Нужна зарядка.|Do you have a USB-C cable? I need a charger.|Есть кабель USB-C? Нужна зарядка.
There's no signal.|There's no signal in the basement.|В подвале нет связи.|I can't call from here. There's no signal.|Отсюда не позвонить, связи нет.
I'm stuck in traffic.|I'm stuck in traffic. I'll be late.|Я застрял в пробке. Опоздаю.|Sorry, I'm stuck in traffic near the bridge.|Прости, я застрял в пробке у моста.
That looks expensive.|Wow, that watch looks expensive.|Ого, эти часы выглядят дорогими.|That looks expensive. Can you afford it?|Выглядит дорого. Ты можешь себе это позволить?
I ordered a taxi.|I ordered a taxi five minutes ago.|Я заказал такси пять минут назад.|Don't walk in the rain. I ordered a taxi.|Не иди под дождём. Я заказал такси.
It's a little chilly.|Take a jacket, it's a little chilly.|Возьми куртку, немного прохладно.|It's a little chilly on the balcony.|На балконе прохладно.
I can't find my wallet.|I can't find my wallet anywhere.|Нигде не могу найти кошелёк.|I can't pay yet. I can't find my wallet.|Пока не могу заплатить. Не нахожу кошелёк.
We ran out of milk.|We ran out of milk. Could you buy some?|Молоко закончилось. Купишь?|No coffee with milk today. We ran out of milk.|Сегодня кофе без молока: оно закончилось.
This chair is broken.|Don't sit there. This chair is broken.|Не садись туда. Этот стул сломан.|Could you replace it? This chair is broken.|Замените, пожалуйста. Этот стул сломан.
My phone died.|My phone died during the concert.|Телефон разрядился во время концерта.|I didn't reply because my phone died.|Не ответил, потому что телефон сел.
I booked a table.|I booked a table for two at seven.|Я забронировал столик на двоих на семь.|No need to wait. I booked a table.|Ждать не придётся. Я забронировал столик.
The food is cold.|Please heat this up. The food is cold.|Подогрей, пожалуйста. Еда остыла.|The food is cold because we waited too long.|Еда холодная, потому что мы слишком долго ждали.
I don't eat meat.|I don't eat meat. Is there a vegetarian option?|Я не ем мясо. Есть вегетарианское блюдо?|I don't eat meat, but I eat fish.|Я не ем мясо, но ем рыбу.
I'm allergic to nuts.|I'm allergic to nuts. Does this contain peanuts?|У меня аллергия на орехи. Здесь есть арахис?|Please check the ingredients. I'm allergic to nuts.|Проверьте состав, у меня аллергия на орехи.
It's on the second floor.|The office is on the second floor.|Офис находится на втором этаже.|Take the stairs. It's on the second floor.|Поднимись по лестнице. Это на втором этаже.
I need directions.|I'm lost. I need directions to the station.|Я заблудился. Подскажите путь к вокзалу.|I need directions to your apartment.|Мне нужны указания, как добраться до твоей квартиры.
I have a headache.|I have a headache. I need some rest.|У меня болит голова. Нужно отдохнуть.|Can we turn the music down? I have a headache.|Можно потише музыку? У меня болит голова.
The tickets sold out.|The tickets sold out in one hour.|Билеты раскупили за час.|We can't go: the tickets sold out.|Мы не попадём: билеты распроданы.
I woke up late.|I woke up late and missed breakfast.|Проснулся поздно и пропустил завтрак.|Sorry for being late. I woke up late.|Извини за опоздание. Я поздно проснулся.
Where's the exit?|Excuse me, where's the exit?|Извините, где выход?|There's so much smoke. Where's the exit?|Так много дыма. Где выход?
Is this seat taken?|Excuse me, is this seat taken?|Извините, это место занято?|Is this seat taken or can I sit here?|Это место занято или можно сесть?
Could you speak slower?|Sorry, could you speak slower?|Извините, не могли бы вы говорить медленнее?|I'm still learning English. Could you speak slower?|Я ещё учу английский. Говорите, пожалуйста, помедленнее.`;
export const HUINGLISH_QUIZ_OTHER_EXAMPLES = Object.freeze(Object.fromEntries(
 rows.split('\n').map(line=>{
   const [phrase,en1,ru1,en2,ru2]=line.split('|');
   if(!phrase||!en1||!ru1||!en2||!ru2)throw Error('Invalid other quiz examples: '+line);
   return [phrase,Object.freeze([{en:en1,ru:ru1},{en:en2,ru:ru2}])];
 })
));