# Split-Second Stopwatch

Keep track of time through a digital stopwatch.

## Introduction
You've always run for the thrill of it — no schedules, no timers, just the sound of your feet on the pavement.
But now that you've joined a competitive running crew, things are getting serious.
Training sessions are timed to the second, and every split second counts.
To keep pace, you've picked up the _Split-Second Stopwatch_ — a sleek, high-tech gadget that's about to become your new best friend.

## Instructions
Your task is to build a stopwatch to keep precise track of lap times.

The stopwatch uses four commands (start, stop, lap, and reset) to keep track of:

1. The current lap's tracked time
2. Previously recorded lap times

What commands can be used depends on which state the stopwatch is in:

1. Ready: initial state
2. Running: tracking time
3. Stopped: not tracking time

| Command | Begin state | End state | Effect                                                   |
| ------- | ----------- | --------- | -------------------------------------------------------- |
| Start   | Ready       | Running   | Start tracking time                                      |
| Start   | Stopped     | Running   | Resume tracking time                                     |
| Stop    | Running     | Stopped   | Stop tracking time                                       |
| Lap     | Running     | Running   | Add current lap to previous laps, then reset current lap |
| Reset   | Stopped     | Ready     | Reset current lap and clear previous laps                |

## Notes from the exercise authors

- All times are formatted in '<hours>:<minutes>:<seconds>' format.
- Hours, minutes, and seconds are formatted using two digits.
- Thus 4 hours, 23 minutes, and 6 seconds is represented as '04:23:06'.
- Tracks are free to convert these times into a format that is the most
- appropriate for their language.
- 
- The advanceTime command is used to simulate the passage of time.
- Some tracks might be able to mock the system time, others might need
- to provide some time-representing value, while others might need to
- pass the current time as an argument to the other commands.

## Functions to implement

- `time(commands)`

<!-- generated from exercism/problem-specifications exercises/split-second-stopwatch (introduction.md, instructions.md); do not edit -->
