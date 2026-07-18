# S1 Sanità selection

**Seed:** `20260718`

Query: `SELECT * FROM Lead WHERE type='HEALTHCARE' AND region=?` then deterministic hash order + soft quotas.

## Campania
- n: 25
- verdictDist: `{'HOT': 13, 'PUBLISHED': 4, 'REVIEW': 8}`
- flagDist: `{'pdf': 17, 'complex': 17, 'group': 15, 'auto': 1, 'nosite': 6}`
- cities (top): `{'Baronissi': 1, "San Cipriano d'Aversa": 1, 'Tufino': 1, 'Grottaminarda': 1, 'Recale': 1, 'Villa Literno': 1, 'Massa di Somma': 1, 'Frattaminore': 1, 'Scala': 1, 'Riardo': 1, 'Villanova del Battista': 1, 'Pagliarone': 1, 'Acerno': 1, 'Forio': 1, 'Zingonia': 1, 'Montesarchio': 1, 'Bellizzi': 1, 'Brusciano': 1, 'Villaricca': 1, 'Santa Maria Capua Vetere': 1}`
- ids: 25 (full list in json)

## Veneto
- n: 25
- verdictDist: `{'HOT': 15, 'PUBLISHED': 4, 'REVIEW': 6}`
- flagDist: `{'pdf': 19, 'complex': 20, 'group': 16, 'nosite': 5}`
- cities (top): `{'Meduna di Livenza': 2, 'Garda': 1, 'Concamarise': 1, 'Porto Viro': 1, 'Palermo': 1, 'Trevignano': 1, 'Tombolo': 1, 'Oppido Mamertina': 1, 'Schio': 1, 'Montegrotto Terme': 1, 'Pressana': 1, 'Castegnero': 1, 'Auronzo di Cadore': 1, 'Cavarzere': 1, 'Nove': 1, 'Torri di Quartesolo': 1, 'Bressanvido': 1, 'Affi': 1, "Castel d'Azzano": 1, 'Saccolongo': 1}`
- ids: 25 (full list in json)
