# V188.94 — словарь поиска/metadata

Словарь сформирован из заданных владельцем ключей и признаков, встречавшихся в присланной SQLite. Он используется как стартовый, но AI может вернуть один новый явно обоснованный тег; новый тег сохраняется как metadata и отправляется владельцу на ревью.

## Площадки

Diesel (объединённый поиск), Diesel Bar, Diesel Hall, Тупик, Мама Анархия, The Last of Vavilone / Vavilon / Вавилон, Сто Ручьёв, Liverpool / Ливерпуль, Балаган Сити, Котельная, Overlock, Понеслось, Pinta Haus, Клуб 12, Клуб 72, ЦЕ, Арена Холл, Башня / Винзавод, Артель Чайка, Коптильня, Литера, Malina.

`bar`, `pub`, `club`, `клуб`, `бар`, `паб` не считаются содержательным словом площадки. Исключение идентичности: `Diesel Bar` и `Diesel Hall` различаются, но запрос `дизель` охватывает оба.

## Жанры/форматы

rock, русский рок, metal, black metal, death metal, deathcore, screamo, indie, post-punk, punk rock, hardcore, электроника, rave, DJ, акустика, авторская песня, вечеринка, квартирник, folk, reggae/ska, blues, emo, alternative, industrial, techno, house, hip-hop/rap, cover/tribute, grunge, nu-metal, metalcore, поэзия, jam/джем, open mic.

Варианты с дефисом/без дефиса и русские/английские алиасы нормализуются в один ключ, например `black-metal` = `black metal` = `блэк-метал`.
