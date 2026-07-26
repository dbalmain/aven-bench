# Reference solution, hand-written. Not shown to any model.
#
# The accumulator arrives as a Proc, because the suite renders upstream's
# `"(x) => x * x"` pseudocode as a Ruby lambda.
module Solution
  def self.accumulate(list, accumulator)
    list.map { |item| accumulator.call(item) }
  end
end
