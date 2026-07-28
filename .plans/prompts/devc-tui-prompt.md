Let's write a plan for a new devcontainer tool (note that another agent is in the process of renaming the 1 existing tool in this repo to devc-bridge, formerly named devc-tools. This repo will house multiple tools under subfolders.

This tool will be a TUI written in Deno. The new tool will go under devc-tui/ folder. We will start by giving it features to modify a vscode workspace file, and a devcontainer.json. The idea is that user runs the tui, and they get a file tree based on a configured root. This filetree has checkboxes to selectively include projects. These projects will get added / removed as bind mounts from the devcontainer.json file and be added / removed from the vs code workspace.

The configured root folder will contain folders that contain a git repo or folders with a .worktrees suffix containing subfolders for worktrees. The base name will correspond to the primary repo:

e.g.
/projecta/.git
/projecta.worktrees/some-feature/
/projectb/.git
/projectb.worktrees/some-other/
/projectb.worktrees/yet-another/

This is important since mounting a worktree subfolder requires binding the respective primary folder in order for git commits to work. This would only apply to the devcontainer.json bind mounts. The VS code project will only reflect explicitly selected options. The cwd where devc-tui is run from will be the primary workspace mount and the vscode file + .devcontainer/devcontainer.json will get created or edited there if already exists

We'll define a ~/.config/devc-tui folder that will contain any config artifacts the tool needs.

We'll also support configuring agent skill folder mounts. Will also be a config for the root skills folder, and tool can toggle bind mounts in the devcontainer.json file

Also important that the tool owns specific mount sections in the devcontainer.json. We can use comment fences. Other config should remain untouched.

We'll add a bash function to scripts/bash_aliases.sh to alias running this tool as devc-tui so we don't have to build it

## Later phase

Not first phase, but we'll also support starting / attaching to devcontainers.
