# Hangman

Implement the logic of the hangman game using functional reactive programming.

# Description

Implement the logic of the hangman game using functional reactive programming.

[Hangman][hangman] is a simple word guessing game.

[Functional Reactive Programming][frp] is a way to write interactive programs.
It differs from the usual perspective in that instead of saying "when the button is pressed increment the counter", you write "the value of the counter is the sum of the number of times the button is pressed."

Implement the basic logic behind hangman using functional reactive programming.
You'll need to install an FRP library for this, this will be described in the language/track specific files of the exercise.

[hangman]: https://en.wikipedia.org/wiki/Hangman_%28game%29
[frp]: https://en.wikipedia.org/wiki/Functional_reactive_programming

## Notes from the exercise authors

- The expected values may be returned from the guess function, or returned from a separate game state call.
- They may also be accessed from a different call for each value, based on what is most idiomatic for the language.
- To explore objects, each guessed letter should be a separate call.

## Functions to implement

- `guess(word, guesses)` — some inputs are invalid and must be rejected

<!-- generated from exercism/problem-specifications exercises/hangman (description.md); do not edit -->
