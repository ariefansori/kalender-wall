-- ---------------------------------------------------------------------------
-- HyprWall — autostart for the current Caelestia Lua dotfiles
--
-- Add this block to ~/.config/caelestia/hypr-user.lua (do not edit files inside
-- ~/.config/hypr/ when using the Caelestia dotfiles). Adjust the path.
-- ---------------------------------------------------------------------------

hl.on("hyprland.start", function()
    hl.exec_cmd("$HOME/Projects/kalender-wall/.venv/bin/hyprwall apply --retry 12 --retry-delay 2 >> $HOME/.cache/hyprwall/autostart.log 2>&1")
end)

-- Legacy `exec-once` (older conf-based setups):
-- exec-once = $HOME/Projects/kalender-wall/.venv/bin/hyprwall apply --retry 12 --retry-delay 2 >> $HOME/.cache/hyprwall/autostart.log 2>&1
