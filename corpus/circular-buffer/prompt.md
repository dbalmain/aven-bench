# Circular Buffer

A data structure that uses a single, fixed-size buffer as if it were connected end-to-end.

# Description

A circular buffer, cyclic buffer or ring buffer is a data structure that uses a single, fixed-size buffer as if it were connected end-to-end.

A circular buffer first starts empty and of some predefined length.
For example, this is a 7-element buffer:

```text
[ ][ ][ ][ ][ ][ ][ ]
```

Assume that a 1 is written into the middle of the buffer (exact starting location does not matter in a circular buffer):

```text
[ ][ ][ ][1][ ][ ][ ]
```

Then assume that two more elements are added — 2 & 3 — which get appended after the 1:

```text
[ ][ ][ ][1][2][3][ ]
```

If two elements are then removed from the buffer, the oldest values inside the buffer are removed.
The two elements removed, in this case, are 1 & 2, leaving the buffer with just a 3:

```text
[ ][ ][ ][ ][ ][3][ ]
```

If the buffer has 7 elements then it is completely full:

```text
[5][6][7][8][9][3][4]
```

When the buffer is full an error will be raised, alerting the client that further writes are blocked until a slot becomes free.

When the buffer is full, the client can opt to overwrite the oldest data with a forced write.
In this case, two more elements — A & B — are added and they overwrite the 3 & 4:

```text
[5][6][7][8][9][A][B]
```

3 & 4 have been replaced by A & B making 5 now the oldest data in the buffer.
Finally, if two elements are removed then what would be returned is 5 & 6 yielding the buffer:

```text
[ ][ ][7][8][9][A][B]
```

Because there is space available, if the client again uses overwrite to store C & D then the space where 5 & 6 were stored previously will be used not the location of 7 & 8.
7 is still the oldest element and the buffer is once again full.

```text
[C][D][7][8][9][A][B]
```

## Notes from the exercise authors

- In general, these circular buffers are expected to be stateful,
- and each language will operate on them differently.
- Tests tend to perform a series of operations, some of which expect a certain result.
- As such, this common test suite can only say in abstract terms what should be done.
- 
- Tests will contain a number of operations. The operation will be specified in the `operation` key.
- Based on the operation, other keys may be present.
- read: Reading from the buffer should succeed if and only if `should_succeed` is true.
-   If it should succeed, it should produce the item at `expected`. 
-   If it should fail, `expected` will not be present. 
- write: Writing the item located at `item` should succeed if and only if `should_succeed` is true.
- overwrite: Write the item located at `item` into the buffer, replacing the oldest item if necessary.
- clear: Clear the buffer.
- 
- Failure of either `read` or `write` may be indicated in a manner appropriate for your language:
- Raising an exception, returning (int, error), returning Option<int>, etc.
- 
- Finally, note that all values are integers.
- If your language contains generics, you may consider allowing buffers to contain other types.
- Tests for that are not included here.
- 

## Functions to implement

- `run(capacity, operations)`

<!-- generated from exercism/problem-specifications exercises/circular-buffer (description.md); do not edit -->
