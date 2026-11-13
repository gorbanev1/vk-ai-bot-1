import { contextMismatch, validNearChoice, HUINGLISH_CONSTRUCTION_HINTS } from './huinglishQuizPedagogy.js';
import { HUINGLISH_QUIZ_LEADS } from './huinglishQuizLeads.js';
import { HUINGLISH_QUIZ_LEAD_EXPLANATIONS } from './huinglishQuizLeadExplanations.js';
import { HUINGLISH_QUIZ_PRONUNCIATIONS } from './huinglishQuizPronunciations.js';
import { HUINGLISH_QUIZ_EXAMPLES } from './huinglishQuizExamples.js';
import { HUINGLISH_QUIZ_OTHER_EXAMPLES } from './huinglishQuizOtherExamples.js';
import { huinglishMeaningImage } from './huinglishQuizMeaningImages.js';

function pronunciation(item) {
    const data=HUINGLISH_QUIZ_PRONUNCIATIONS[item.answer] ||
        (item.ipa && item.ru ? item : null);
    if (!data?.ipa || !data?.ru) throw Error('No pronunciation for '+item.answer);
    return ['🇬🇧 '+item.answer,'🔤 '+data.ipa,'🗣 '+data.ru,'🇷🇺 '+item.meaning];
}

function exampleBlock(item,count) {
    const examples=HUINGLISH_QUIZ_EXAMPLES[item.answer] ||
        HUINGLISH_QUIZ_OTHER_EXAMPLES[item.answer] || [];
    if (examples.length<count) throw Error('Not enough real examples for '+item.answer);
    return examples.slice(0,count).flatMap((example,index)=>[
        '💬 '+(count>1?'Пример '+(index+1)+': ':'Пример: ')+example.en,
        '↳ '+example.ru,
    ]);
}

function grammaticalRule(item) {
    const rule=HUINGLISH_CONSTRUCTION_HINTS.get(item.answer);
    if(!rule)throw Error('No reviewed grammar rule for '+item.answer);
    return '📘 Грамматика: '+rule;
}
function selectedOption(item,{includeExamples=false,right=null}={}) {
    if(item.trapExplanation) return [
        '🇬🇧 '+item.answer,
        validNearChoice(item)
            ? '⚠️ В другом контексте так сказать можно, но здесь смысл другой.'
            : '⚠️ Разбор ошибки именно в выбранной фразе:',
        '💡 Почему не подходит: '+item.trapExplanation,
    ];
    return [
        ...pronunciation(item),
        '📍 Уместно, когда '+item.usage+'.',
        ...huinglishMeaningImage(item),
        ...(right&&right.answer!==item.answer?[
            '✅ Сама фраза правильная. '+contextMismatch(right,item)
        ]:[]),
        ...(includeExamples?['🏠 КАК ЭТО ЗВУЧИТ В БЫТУ:',...exampleBlock(item,2)]:[]),
    ];
}

// Default: teach the right answer on a wrong click. Explicit hide mode retains
// the former behavior until a participant selects the correct button.
export function buildHuinglishQuizAnswerExplanation({
    right,picked,correct,shortCorrect=false,shortWrong=false,revealCorrect=true,
}) {
    if(!right||!picked)throw Error('Missing quiz answers');
    if(correct&&shortCorrect)
        return ['✅ ДА, ПРАВИЛЬНО!',...pronunciation(right)].join('\n');

    if(!correct&&shortWrong) {
        const lines=['❌ НЕТ, ЭТО НЕ ПОДХОДИТ.','',
            '🔴 ТВОЙ ВАРИАНТ:',...selectedOption(picked,{right})];
        if(revealCorrect) lines.push('','✅ ПРАВИЛЬНЫЙ ВАРИАНТ:',...pronunciation(right),
            '💡 Почему подходит: '+right.scene+'.',
            'Так говорят, когда '+right.usage+'.',
            ...huinglishMeaningImage(right));
        return lines.join('\n');
    }

    const lead=HUINGLISH_QUIZ_LEADS[right.answer];
    const source=HUINGLISH_QUIZ_LEAD_EXPLANATIONS[right.answer];
    const sourceReading=source?.ru||source?.russian;
    const sourceMeaning=source?.translation||source?.meaning;
    if(!lead||!source?.ipa||!sourceReading||!sourceMeaning)
        throw Error('No complete source-line breakdown: '+right.answer);
    const result=[
        correct?'✅ ПРАВИЛЬНО!':'❌ НЕПРАВИЛЬНО',
        '',
        '🧩 ЗАДАНИЕ: '+right.scene,
        '',
        '📖 ЧТО ЗНАЧИЛ ВОПРОС:',
        'A: '+lead,
        '🔤 '+source.ipa,
        '🗣 '+sourceReading,
        '🇷🇺 '+sourceMeaning,
        '',
    ];
    if(!correct) result.push(
        '❌ ТВОЙ ВАРИАНТ:',
        ...selectedOption(picked,{includeExamples:true,right}),
        '',
    );
    if(correct||revealCorrect) result.push(
        correct?'✅ ТВОЙ ОТВЕТ:':'✅ ПРАВИЛЬНЫЙ ОТВЕТ:',
        ...pronunciation(right),
        '💡 Почему подходит: '+right.scene+'.',
        grammaticalRule(right),
        'Так говорят, когда '+right.usage+'.',
        ...huinglishMeaningImage(right),
        '',
        '🏠 ЕЩЁ ДВА ЖИВЫХ ПРИМЕРА:',
        ...exampleBlock(right,2),
    );
    const message=result.join('\n');
    if(message.length>3500) throw Error('Quiz explanation too long for VK: '+message.length);
    return message;
}
