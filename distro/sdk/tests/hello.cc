#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

// Exceptions are deliberately absent: clang gives wasm32-linux the generic
// Itanium C++ ABI, which cannot leave a wasm catch block.
int main() {
  std::vector<std::string> words{"C++", "from", "hello"};
  std::reverse(words.begin(), words.end());
  std::cout << words[0] << ' ' << words[1] << ' ' << words[2] << std::endl;
  return 0;
}
