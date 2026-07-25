# Swift Scheduling

Convert delivery date descriptions to actual delivery dates.

## Introduction
This week, it is your turn to take notes in the department's planning meeting.
In this meeting, your boss will set delivery dates for all open work items.
Annoyingly, instead of specifying the _actual_ delivery dates, your boss will only _describe them_ in an abbreviated format.
As many of your colleagues won't be familiar with this corporate lingo, you'll need to convert these delivery date descriptions to actual delivery dates.

## Instructions
Your task is to convert delivery date descriptions to _actual_ delivery dates, based on when the meeting started.

There are two types of delivery date descriptions:

1. Fixed: a predefined set of words.
2. Variable: words that have a variable component, but follow a predefined set of patterns.

## Fixed delivery date descriptions

There are three fixed delivery date descriptions:

- `"NOW"`
- `"ASAP"` (As Soon As Possible)
- `"EOW"` (End Of Week)

The following table shows how to translate them:

| Description | Meeting start                 | Delivery date                       |
| ----------- | ----------------------------- | ----------------------------------- |
| `"NOW"`     | -                             | Two hours after the meeting started |
| `"ASAP"`    | Before 13:00                  | Today at 17:00                      |
| `"ASAP"`    | After or at 13:00             | Tomorrow at 13:00                   |
| `"EOW"`     | Monday, Tuesday, or Wednesday | Friday at 17:00                     |
| `"EOW"`     | Thursday or Friday            | Sunday at 20:00                     |

## Variable delivery date descriptions

There are two variable delivery date description patterns:

- `"<N>M"` (N-th month)
- `"Q<N>"` (N-th quarter)

| Description | Meeting start             | Delivery date                                             |
| ----------- | ------------------------- | --------------------------------------------------------- |
| `"<N>M"`    | Before N-th month         | At 8:00 on the _first_ workday of this year's N-th month  |
| `"<N>M"`    | After or in N-th month    | At 8:00 on the _first_ workday of next year's N-th month  |
| `"Q<N>"`    | Before or in N-th quarter | At 8:00 on the _last_ workday of this year's N-th quarter |
| `"Q<N>"`    | After N-th quarter        | At 8:00 on the _last_ workday of next year's N-th quarter |

~~~~exercism/note
A workday is a Monday, Tuesday, Wednesday, Thursday, or Friday.

A year has four quarters, each with three months:
1. January/February/March
2. April/May/June
3. July/August/September
4. October/November/December.
~~~~

## Notes from the exercise authors

- The dates are formatted per 
- https://www.ecma-international.org/ecma-262/5.1/#sec-15.9.1.15.
- 
- Tracks that support changing the system's current time can consider 
- setting the system's current time to the meeting start instead of 
- passing it as an argument.

## Functions to implement

- `deliveryDate(meetingStart, description)`

<!-- generated from exercism/problem-specifications exercises/swift-scheduling (introduction.md, instructions.md); do not edit -->
