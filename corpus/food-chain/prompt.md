# Food Chain

Generate the lyrics of the song 'I Know an Old Lady Who Swallowed a Fly'.

# Description

Generate the lyrics of the song 'I Know an Old Lady Who Swallowed a Fly'.

While you could copy/paste the lyrics, or read them from a file, this problem is much more interesting if you approach it algorithmically.

This is a [cumulative song][cumulative-song] of unknown origin.

This is one of many common variants.

```text
I know an old lady who swallowed a fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a spider.
It wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a bird.
How absurd to swallow a bird!
She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a cat.
Imagine that, to swallow a cat!
She swallowed the cat to catch the bird.
She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a dog.
What a hog, to swallow a dog!
She swallowed the dog to catch the cat.
She swallowed the cat to catch the bird.
She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a goat.
Just opened her throat and swallowed a goat!
She swallowed the goat to catch the dog.
She swallowed the dog to catch the cat.
She swallowed the cat to catch the bird.
She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a cow.
I don't know how she swallowed a cow!
She swallowed the cow to catch the goat.
She swallowed the goat to catch the dog.
She swallowed the dog to catch the cat.
She swallowed the cat to catch the bird.
She swallowed the bird to catch the spider that wriggled and jiggled and tickled inside her.
She swallowed the spider to catch the fly.
I don't know why she swallowed the fly. Perhaps she'll die.

I know an old lady who swallowed a horse.
She's dead, of course!
```

[cumulative-song]: https://en.wikipedia.org/wiki/Cumulative_song

## Notes from the exercise authors

- JSON doesn't allow for multi-line strings, so all verses are presented 
- here as arrays of strings. It's up to the test generator to join the 
- lines together with line breaks.
- Some languages test for the verse() method, which takes a start verse 
- and optional end verse, but other languages have only tested for the full poem.
- For those languages in the latter category, you may wish to only 
- implement the full song test and leave the rest alone, ignoring the start 
- and end verse fields.

## Functions to implement

- `recite(startVerse, endVerse)`

<!-- generated from exercism/problem-specifications exercises/food-chain (description.md); do not edit -->
