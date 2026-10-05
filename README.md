# Castlefall

A party word game of hidden teams for about 6–10 people, playing together in person.
It's [Castle of the Devil](https://boardgamegeek.com/boardgame/25951/castle-devil) meets
[Spyfall](https://boardgamegeek.com/boardgame/166384/spyfall).

Everyone gets the same list of words and one secret word. Half the table has one word and half has another.
Talk it over, then either name your team or guess the other team's word. Full rules are in
[`public/rules.html`](public/rules.html), or tap the logo in the app.

This is a rewrite of [betaveros/castlefall](https://github.com/betaveros/castlefall) with a new interface.
The game plays the same way.

## Running it

```sh
npm install
npm start            # http://localhost:8372
```

Send friends a link such as `http://your-host:8372/#game-night`. The part after `#` is the room name.

| Env var | Default   |                                           |
| ------- | --------- | ----------------------------------------- |
| `PORT`  | `8372`    | HTTP + WebSocket port (WebSocket at `/ws`) |
| `HOST`  | `0.0.0.0` | Interface to bind                          |

`npm run dev` restarts on server changes. `npm test` runs the server tests.

One Node process serves both the static page and the WebSocket. There is no frontend build step, and the only
dependency is `ws`. Behind a reverse proxy, forward `/ws` with WebSocket upgrade headers.

## What's new compared to the original

- **Proper join screen**: name and room fields replace browser `prompt()`s, with your name remembered. A checkbox in the room switches you to just watching.
- **Built for phones**: a large word card you tap to hide or reveal, a plain word list you can tap, and a one-column layout that puts your word first.
- **Private notes**: tap words to cross them out and tap players to mark them ✓ teammate or ✗ rival. Notes stay on your device and survive a refresh.
- **Shared timer**: a sticky countdown banner for everyone, with a warning colour, optional beeps and vibration, and a stop button. Lengths run from 30s to 2 min.
- **Reveal**: when the next round starts, the previous round's teams appear side by side with your team marked. Older rounds are in a collapsible history.
- **Resilient connection**: automatic reconnect with backoff, and a page refresh drops you back into your seat with the same word.
- **Safer "next round"**: starting a new round mid-game takes a second tap.
- Accessible focus states and reduced-motion support.
- **Word lists**: `things`, `codenames-style`, `movies`, `places`, `concepts`, `famous-figures` and `numbers` (1–999), all written for this project, plus EFF's short diceware list.

## Word lists

Add newline-separated `.txt` files to `wordlists/`, then restart. The file name becomes the list name.
`eff-short.txt` is [EFF's short diceware list](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases)
([CC-BY 3.0](http://creativecommons.org/licenses/by/3.0/us/)).

## Trust model

Like the original, this is for friends. Anyone in a room can remove anyone, and joining with a name that's already
in the round takes over that seat and its word. That's how you rejoin from another device.

## License

MIT. Original game app © 2018 Brian Chen (betaveros).
