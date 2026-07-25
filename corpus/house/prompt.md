# House

Output the nursery rhyme 'This is the House that Jack Built'.

# Description

Recite the nursery rhyme 'This is the House that Jack Built'.

> [The] process of placing a phrase of clause within another phrase of clause is called embedding.
> It is through the processes of recursion and embedding that we are able to take a finite number of forms (words and phrases) and construct an infinite number of expressions.
> Furthermore, embedding also allows us to construct an infinitely long structure, in theory anyway.

- [papyr.com][papyr]

The nursery rhyme reads as follows:

```text
This is the house that Jack built.

This is the malt
that lay in the house that Jack built.

This is the rat
that ate the malt
that lay in the house that Jack built.

This is the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the man all tattered and torn
that kissed the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the priest all shaven and shorn
that married the man all tattered and torn
that kissed the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the rooster that crowed in the morn
that woke the priest all shaven and shorn
that married the man all tattered and torn
that kissed the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the farmer sowing his corn
that kept the rooster that crowed in the morn
that woke the priest all shaven and shorn
that married the man all tattered and torn
that kissed the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.

This is the horse and the hound and the horn
that belonged to the farmer sowing his corn
that kept the rooster that crowed in the morn
that woke the priest all shaven and shorn
that married the man all tattered and torn
that kissed the maiden all forlorn
that milked the cow with the crumpled horn
that tossed the dog
that worried the cat
that killed the rat
that ate the malt
that lay in the house that Jack built.
```

[papyr]: https://papyr.com/hypertextbooks/grammar/ph_noun.htm

## Notes from the exercise authors

- JSON doesn't allow for multi-line strings, so all verses are presented 
- here as arrays of strings. It's up to the test generator to join the 
- lines together with line breaks.
- Some languages test for the verse() method, which takes a start verse 
- and optional end verse, but other languages have only tested for the full poem.
- For those languages in the latter category, you may wish to only 
- implement the full song test and leave the rest alone, ignoring the startVerse 
- and endVerse fields.

## Functions to implement

- `recite(startVerse, endVerse)`

<!-- generated from exercism/problem-specifications exercises/house (description.md); do not edit -->
