# Reference solution, hand-written. Not shown to any model.
module Solution
  def self.steps(number)
    raise ArgumentError, "Only positive integers are allowed" if number < 1

    count = 0
    until number == 1
      number = number.even? ? number / 2 : 3 * number + 1
      count += 1
    end
    count
  end
end
