# Line Up

Help lining up customers at Yaʻqūb's Deli.

## Introduction
Your friend Yaʻqūb works the counter at a deli in town, slicing, weighing, and wrapping orders for a line of hungry customers that gets longer every day.
Waiting customers are starting to lose track of who is next, so he wants numbered tickets they can use to track the order in which they arrive.

To make the customers feel special, he does not want the ticket to have only a number on it.
They shall get a proper English sentence with their name and number on it.

## Instructions
Given a name and a number, your task is to produce a sentence using that name and that number as an [ordinal numeral][ordinal-numeral].
Yaʻqūb expects to use numbers from 1 up to 999.

Rules:

- Numbers ending in 1 (unless ending in 11) → `"st"`
- Numbers ending in 2 (unless ending in 12) → `"nd"`
- Numbers ending in 3 (unless ending in 13) → `"rd"`
- All other numbers → `"th"`

Examples:

- `"Mary", 1` → `"Mary, you are the 1st customer we serve today. Thank you!"`
- `"John", 12` → `"John, you are the 12th customer we serve today. Thank you!"`
- `"Dahir", 162` → `"Dahir, you are the 162nd customer we serve today. Thank you!"`

[ordinal-numeral]: https://en.wikipedia.org/wiki/Ordinal_numeral

## Notes from the exercise authors

- Names are chosen without Unicode characters to keep the exercise simple.
- 
- The tests are ordered starting with small regular cases and coming to
- bigger and irregular cases later on.

## Functions to implement

- `format(name, number)`

<!-- generated from exercism/problem-specifications exercises/line-up (introduction.md, instructions.md); do not edit -->
