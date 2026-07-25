# Dominoes

Make a chain of dominoes.

## Introduction
In Toyland, the trains are always busy delivering treasures across the city, from shiny marbles to rare building blocks.
The tracks they run on are made of colorful domino-shaped pieces, each marked with two numbers.
For the trains to move, the dominoes must form a perfect chain where the numbers match.

Today, an urgent delivery of rare toys is on hold.
You've been handed a set of track pieces to inspect.
If they can form a continuous chain, the train will be on its way, bringing smiles across Toyland.
If not, the set will be discarded, and another will be tried.

The toys are counting on you to solve this puzzle.
Will the dominoes connect the tracks and send the train rolling, or will the set be left behind?

## Instructions
Make a chain of dominoes.

Compute a way to order a given set of domino stones so that they form a correct domino chain.
In the chain, the dots on one half of a stone must match the dots on the neighboring half of an adjacent stone.
Additionally, the dots on the halves of the stones without neighbors (the first and last stone) must match each other.

For example given the stones `[2|1]`, `[2|3]` and `[1|3]` you should compute something
like `[1|2] [2|3] [3|1]` or `[3|2] [2|1] [1|3]` or `[1|3] [3|2] [2|1]` etc, where the first and last numbers are the same.

For stones `[1|2]`, `[4|1]` and `[2|3]` the resulting chain is not valid: `[4|1] [1|2] [2|3]`'s first and last numbers are not the same.
4 != 3

Some test cases may use duplicate stones in a chain solution, assume that multiple Domino sets are being used.

## Notes from the exercise authors

- Inputs are given as lists of two-element lists.
- Feel free to convert the input to a sensible type in the specific language
- For example, if the target language has 2-tuples, that is a good candidate.
- 
- There are two levels of this exercise that can be implemented and/or tested:
- 
- 1: Given a list of dominoes, determine whether it can be made into a chain.
- Under this scheme, the submitted code only needs to return a boolean.
- The test code only needs to check that that boolean value matches up.
- 
- 2: Given a list of dominoes, determine one possible chain, if one exists, or else conclude that none can be made.
- Under this scheme, the submitted code needs to either return a chain, or signal that none exists.
- Different languages may do this differently:
- return Option<Vector<Domino>>, return ([]Domino, error), raise exception, etc.
- The test code needs to check that the returned chain is correct (see below).
- 
- It's infeasible to list every single possible result chain in this file.
- That's because for even a simple list [(1, 2), (2, 3), (3, 1)],
- the possible chains are that order, any rotation of that order,
- and any rotation of that order with all dominoes reversed.
- 
- For this reason, this JSON file will only list whether a chain is possible.
- Tracks wishing to verify correct results of the second level must separately perform this verification.
- 
- The properties to verify are:
- 1. The submitted code claims there is a chain if and only if there actually is one.
- 2. The number of dominoes in the output equals the number of dominoes in the input.
- 3a. For each adjacent pair of dominoes ... (a, b), (c, d) ...: b is equal to c.
- 3b. For the dominoes on the ends (a, b) ... (c, d): a is equal to d.
- 4. Every domino appears in the output an equal number of times as the number of times it appears in the input.
- (in other words, the dominoes in the output are the same dominoes as the ones in the input)
- 
- Feel free to examine the Rust track for ideas on implementing the second level verification.

## Functions to implement

- `canChain(dominoes)`

<!-- generated from exercism/problem-specifications exercises/dominoes (introduction.md, instructions.md); do not edit -->
