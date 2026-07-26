# Deliberately wrong: the two halves of the sentence are swapped.
#
# `bun run verify` runs this through the *generated* suite and requires a
# reported failure. A generator that emitted a vacuous or self-satisfying suite
# would go green here, so this fixture is the guard against a false green.
module Solution
  def self.two_fer(name)
    "One for me, one for #{name || 'you'}."
  end
end
