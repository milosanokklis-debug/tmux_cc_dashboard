#!/usr/bin/env bats

@test "probe: always fails" {
  run false
  [ "$status" -eq 0 ]
}
