import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extractVkStructuredEventsFromBootstrap,
    formatVkStructuredEventEvidence,
} from '../../src/features/events/vkStructuredEventEvidence.js';

test('V188.19 VK structured event prefers concrete main_address venue over city', () => {
    const bootstrap = [{
        method: 'groups.getById',
        response: {
            groups: [{
                id: 231705804,
                type: 'event',
                name: '03.10 | Shoegaze Fall Night 2',
                start_date: 1791039600,
                city: { id: 42, title: 'Воронеж' },
                addresses: {
                    main_address: {
                        title: 'Котельная',
                        address: 'ул. 20 лет Октября, 75А',
                        city: { id: 42, title: 'Воронеж' },
                    },
                },
                description: 'Dog Silent\ngoodnight kisses\nМесто: Котельная\nДвери: 18:00',
            }],
        },
    }];

    const [event] = extractVkStructuredEventsFromBootstrap(bootstrap);
    assert.ok(event);
    assert.equal(event.venue, 'Котельная');
    assert.equal(event.address, 'ул. 20 лет Октября, 75А, Воронеж');
    const evidence = formatVkStructuredEventEvidence(event);
    assert.match(evidence.text, /Место: Котельная/u);
    assert.match(evidence.text, /Адрес: ул\. 20 лет Октября, 75А, Воронеж/u);
    assert.doesNotMatch(evidence.text, /Место: Воронеж/u);
});
