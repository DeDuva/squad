Feature: Init command

  Scenario: Init in existing project shows ready message
    Given a temp directory with a ".squad" subdirectory
    When I run "squad init" in the temp directory
    Then the output contains "Squad initialized"
    And the output contains "already exists"
    And the exit code is 0

  Scenario: Init exit code is zero on success
    When I run "squad init"
    Then the exit code is 0
