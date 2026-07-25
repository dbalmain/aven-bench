# Micro Blog

Given an input string, truncate it to 5 characters.

# Description

You have identified a gap in the social media market for very very short posts.
Now that Twitter allows 280 character posts, people wanting quick social media updates aren't being served.
You decide to create your own social media network.

To make your product noteworthy, you make it extreme and only allow posts of 5 or less characters.
Any posts of more than 5 characters should be truncated to 5.

To allow your users to express themselves fully, you allow Emoji and other Unicode.

The task is to truncate input strings to 5 characters.

## Text Encodings

Text stored digitally has to be converted to a series of bytes.
There are 3 ways to map characters to bytes in common use.

- **ASCII** can encode English language characters.
  All characters are precisely 1 byte long.
- **UTF-8** is a Unicode text encoding.
  Characters take between 1 and 4 bytes.
- **UTF-16** is a Unicode text encoding.
  Characters are either 2 or 4 bytes long.

UTF-8 and UTF-16 are both Unicode encodings which means they're capable of representing a massive range of characters including:

- Text in most of the world's languages and scripts
- Historic text
- Emoji

UTF-8 and UTF-16 are both variable length encodings, which means that different characters take up different amounts of space.

Consider the letter 'a' and the emoji '😛'.
In UTF-16 the letter takes 2 bytes but the emoji takes 4 bytes.

The trick to this exercise is to use APIs designed around Unicode characters (codepoints) instead of Unicode codeunits.

## Notes from the exercise authors

- This exercise is only applicable to languages that use UTF-8, UTF-16
- or other variable width Unicode compatible encoding as their internal
- string representation.
- 
- This exercise is probably too easy in languages that use Unicode aware
- string slicing.
- 
- When adding additional tests to the problem specification, consider that
- in progress solutions might not fail due to UTF-8 and UTF-16
- differences.
- 
- Avoid adding tests that involve characters (graphemes) that are made up
- of multiple characters, or introduce them as a more advanced step.
- 
- Consider adding a track specific hint.md about if your language uses
- UTF-8, UTF-16 or other for its internal string representation.

## Functions to implement

- `truncate(phrase)`

<!-- generated from exercism/problem-specifications exercises/micro-blog (description.md); do not edit -->
