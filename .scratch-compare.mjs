import { compareEventsDeterministic } from "./src/features/events/eventDuplicateResolution.js";
const a={title:"Первый ХВГ-Фест",eventDate:"2026-10-17",eventTime:"19:00",venue:"Diesel Hall, Воронеж",participants:["Tony Tyler","Озвучено","Бульвар Эмили","Редкость","Тип привязанности"]};
const b={title:"ХВГ",eventDate:"2026-10-17",eventTime:"19:00",venue:"PESEL HALL",participants:["TONY TYLER","Озвучено","Бульвар Эмили","Редкость","Тип привязанности"]};
console.dir(compareEventsDeterministic(a,b),{depth:5});
