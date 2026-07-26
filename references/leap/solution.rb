# Reference solution, hand-written. Not shown to any model.
module Solution
  def self.leap_year(year)
    (year % 4).zero? && (!(year % 100).zero? || (year % 400).zero?)
  end
end
