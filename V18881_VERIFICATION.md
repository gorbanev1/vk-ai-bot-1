# V188.81 verification

- Active regression suite: 158/158 passed.
- Added regression coverage for:
  - secondary configured-source visibility;
  - `26.08-30.08` range/year poisoning;
  - phone-number/date poisoning;
  - Telegram `traceAi` callback;
  - multi-snippet `evidence` separated by `||`.
- Existing DB sample from the supplied diagnostic archive was checked with the new date-evidence rules:
  - accepted from old rows: `vk:poneslosbar_vrn/23297`, `vk:pinta_haus/7757`, `vk:12bpg/12659`;
  - hidden as incompatible with the new text-date policy: image-only old rows `vk:12bpg/12670`, `vk:12bpg/12661`;
  - hidden as poisoned: `vk:naryadny.rest/201` phone-derived date and `tg:kommunavrn/859` range-derived 2030 date.
