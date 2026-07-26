# Reference solution, hand-written. Not shown to any model.
#
# The `function` arguments arrive as Procs: the suite renders upstream's
# `"(acc, el) -> el + acc"` pseudocode as a Ruby lambda. `foldl`'s division case
# is why `RB_EMIT` emits `fdiv` — nothing here has to know about that.
module Solution
  def self.append(list1, list2)
    list1 + list2
  end

  def self.concat(lists)
    lists.flatten(1)
  end

  def self.filter(list, function)
    list.select { |item| function.call(item) }
  end

  def self.length(list)
    list.length
  end

  def self.map(list, function)
    list.map { |item| function.call(item) }
  end

  def self.foldl(list, initial, function)
    list.reduce(initial) { |acc, el| function.call(acc, el) }
  end

  def self.foldr(list, initial, function)
    list.reverse.reduce(initial) { |acc, el| function.call(acc, el) }
  end

  def self.reverse(list)
    list.reverse
  end
end
