/vm test failed:/ {
    failures[++failure_count] = $0
}

NR <= 100 {
    print
    next
}

{
    tail[NR % 30] = $0
}

END {
    start = 101
    if (NR > 130) {
        print "[vm test output truncated: " NR - 130 " lines omitted]"
        start = NR - 29
    }
    for (line = start; line <= NR; line++)
        print tail[line % 30]
    for (failure = 1; failure <= failure_count; failure++)
        print failures[failure]
}
