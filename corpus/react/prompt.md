# React

Implement a basic reactive system.

# Description

Implement a basic reactive system.

Reactive programming is a programming paradigm that focuses on how values are computed in terms of each other to allow a change to one value to automatically propagate to other values, like in a spreadsheet.

Implement a basic reactive system with cells with settable values ("input" cells) and cells with values computed in terms of other cells ("compute" cells).
Implement updates so that when an input value is changed, values propagate to reach a new stable system state.

In addition, compute cells should allow for registering change notification callbacks.
Call a cell’s callbacks when the cell’s value in a new stable state has changed from the previous stable state.

## Notes from the exercise authors

- Note that, due to the nature of this exercise,
- the tests are specified using their cells and a series of operations to perform on the cells.
- 
- Each object in the `cells` array has a `name` and `type` (`input` or `output`).
- input cells have an `initial_value`, and compute cells have `inputs` and `compute_function`
- 
- Each object in the `operations` array has a `type`.
- Depending on the type, it also has additional fields.
- The possible types and semantics of their fields are as follows:
- 
- * expect_cell_value (`cell`, `value`): Expect that cell `cell` has value `value`.
- * set_value (`cell`, `value`, optionally `expect_callbacks`, `expect_callbacks_not_to_be_called`): Sets input cell `cell` to value `value`.
-   Expect that, as a result, all callbacks in `expect_callbacks` (if present) were called exactly once with the designated value
-   Expect that no callbacks in `expect_callbacks_not_to_be_called` (if present) were called as a result.
- * add_callback (`cell`, `name`): Adds a callback to cell `cell`. Store the callback ID in a variable named `name`.
-   all callbacks are assumed to simply store the values they're called with in some array.
- * remove_callback (`cell`, `name`): Removes the callback `name` from cell `cell`.
- 
- Additional notes:
- 
- These tests only describe compute cells with up to two inputs.
- Some languages may choose to have two functions: create_compute1 and create_compute2.
- The compiler can then ensure that you never pass a two-input function to a one-input compute cell.
- (This benefit only exists for statically typed languages).
- If your track does this, you should test that all combinations of
- (compute1, compute2) can depend on (input, compute1, compute2) are tested.
- Other languages simply have a single create_compute function, taking a list of input cells.
- Of the languages in this category, there are two subcategories:
- - In some languages, the compute function might take as many inputs as there are input cells.
-   (it might be very difficult to write the type signature for create_compute in statically typed languages!)
- - In other languages, the compute function might always take a single input (the list of values)
-   (again this gives up the ability to check that the arities match)
- Both subcategories using create_compute have the benefit of more flexibility in arity,
- fewer repetitive tests (only need to test that compute cells can depend on compute cells and input cells),
- and likely less repetitive code.
- 
- Finally, note that all values are integers.
- If your language supports generics, you may consider allowing reactors to act on other types.
- Tests for that are not included here.
- 

## Functions to implement

- `react(cells, operations)`

<!-- generated from exercism/problem-specifications exercises/react (description.md); do not edit -->
