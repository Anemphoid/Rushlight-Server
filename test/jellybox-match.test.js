// Which result /play picks. Pure function, so no server: the searches are what Jellyfin really returns for a
// short query, in its own order, with the song that was asked for lower down than titles that only share a word.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestMatch, normalize } from '../src/music/match.js'

const song = (title, artist = 'X', extra = {}) => ({ kind: 'song', id: title, title, artist, album: '', ...extra })
const album = (title) => ({ kind: 'album', id: 'al-' + title, title, artist: 'X', album: '' })
const artist = (title) => ({ kind: 'artist', id: 'ar-' + title, title, artist: '' })

test('"the chain" plays The Chain, not a title that only has "chain" in it', () => {
  const results = [song('Chain Breaker', '$uicideboy$'), song('Chain of Fools', 'Aretha Franklin'), song('The Chain', 'Fleetwood Mac'), song('Chain Reaction')]
  assert.equal(bestMatch(results, 'the chain').artist, 'Fleetwood Mac')
})

test('a remaster or live tail on the title still counts as the same title', () => {
  for (const title of ['The Chain (2004 Remaster)', 'The Chain - 2004 Remaster', 'The Chain [Live]']) {
    const results = [song('Chain Breaker'), song('Chained to the Rhythm'), song(title, 'Fleetwood Mac')]
    assert.equal(bestMatch(results, 'the chain').title, title)
  }
})

test('exact beats a tail, a tail beats a prefix, a prefix beats words in another order', () => {
  const results = [song('Chain Hang Low'), song('The Chain Gang'), song('The Chain (Live)'), song('The Chain')]
  assert.equal(bestMatch(results, 'the chain').title, 'The Chain')
  assert.equal(bestMatch(results.slice(0, 3), 'the chain').title, 'The Chain (Live)')
  assert.equal(bestMatch(results.slice(0, 2), 'the chain').title, 'The Chain Gang')
})

test('case, accents, punctuation and "&" do not matter', () => {
  assert.equal(normalize('  Beyoncé — Halo!  '), 'beyonce halo')
  assert.equal(normalize('Rock & Roll'), 'rock and roll')
  assert.equal(bestMatch([song('Rock and Roll'), song('Rock')], 'ROCK & ROLL').title, 'Rock and Roll')
  assert.equal(bestMatch([song('Halo (Remix)'), song('Halo')], 'halo!').title, 'Halo')
})

test('a song beats an album or artist of the same standing; an exact artist beats a loose song', () => {
  assert.equal(bestMatch([album('Rumours'), artist('Rumours'), song('Rumours')], 'rumours').kind, 'song')
  assert.equal(bestMatch([song('Fleetwood Mac Tribute Night'), artist('Fleetwood Mac')], 'fleetwood mac').kind, 'artist')
})

test('with nothing that matches, Jellyfin\'s own first result is used, and an empty list gives nothing', () => {
  const results = [song('Alpha'), song('Beta')]
  assert.equal(bestMatch(results, 'zzz').title, 'Alpha')
  assert.equal(bestMatch([], 'anything'), undefined)
})

test('every word counts: "dark side" finds the song with both words, not one with only "side"', () => {
  const results = [song('Side by Side'), song('The Dark Side of the Moon'), song('Dark Horse')]
  assert.equal(bestMatch(results, 'dark side').title, 'The Dark Side of the Moon')
})
