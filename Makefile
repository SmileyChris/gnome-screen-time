UUID             = screen-time@gnome-screen-time
VERSION          = 1.2.1
EXTENSIONS_DIR   = $(HOME)/.local/share/gnome-shell/extensions
EXTENSION_DIR    = $(EXTENSIONS_DIR)/$(UUID)
# `make reload` installs under a throwaway UUID of this shape.
DEV_UUID_GLOB    = screen-time-dev-*@gnome-screen-time
SRC_DIR          = src
SCHEMAS_DIR      = $(SRC_DIR)/schemas
DIST_DIR         = dist
PACK_FILE        = $(DIST_DIR)/$(UUID).shell-extension.zip
COMPANION_TOOL   = python3 companion/tools/build.py
HOST_SCRIPT      = $(abspath companion/host/screen-time-host.js)
HOST_MANIFEST    = org.gnome.shell.extensions.screen_time.json
BRAVE_HOSTS_DIR  = $(HOME)/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts
CHROME_HOSTS_DIR = $(HOME)/.config/google-chrome/NativeMessagingHosts
ZEN_HOSTS_DIR    = $(HOME)/.mozilla/native-messaging-hosts

.PHONY: all build schemas install uninstall reload unreload pack companion-build companion-install companion-uninstall lint check test clean restart

# Disables and deletes every dev copy left behind by `make reload`.
REMOVE_DEV_COPIES = for d in $(EXTENSIONS_DIR)/$(DEV_UUID_GLOB); do \
	  [ -d "$$d" ] || continue; \
	  gnome-extensions disable "$$(basename $$d)" 2>/dev/null || true; \
	  rm -rf "$$d"; \
	  echo "Removed $$(basename $$d)"; \
	done

all: build

# Compile GSettings schemas
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

build: schemas

# Install to the local GNOME Shell extensions directory. Copying the whole of
# src/ means a new module never has to be registered anywhere. If it is in
# src/, it ships.
#
# The old copy is deleted first, never copied over. A running Shell keeps
# schemas/gschemas.compiled memory-mapped; rewriting those bytes under the
# same inode changes what the live mapping reads, and a GSettings lookup that
# then fails takes the session down with it. Unlinking leaves the old inode
# alive for anything still mapping it. This replaces the directory wholesale,
# so files dropped from src/ are cleaned out rather than left behind. The
# trailing slash is stripped because `rm -rf link/` empties a symlinked
# install's target instead of removing the link.
install: build
	@ext='$(EXTENSION_DIR)'; ext=$${ext%/}; \
	[ -n "$$ext" ] || { echo "install: EXTENSION_DIR must not be empty" >&2; exit 1; }; \
	rm -rf "$$ext" && mkdir -p "$$ext" && cp -r "$(SRC_DIR)"/* "$$ext"/ && \
	echo "Installed to $$ext"
	@# A dev copy from `make reload` would otherwise stay enabled across
	@# logins with the production copy switched off; installing means we
	@# are done iterating.
	@if ls -d $(EXTENSIONS_DIR)/$(DEV_UUID_GLOB) >/dev/null 2>&1; then \
		$(MAKE) --no-print-directory unreload; \
	fi
	@echo "Reload GNOME Shell: log out/in on Wayland, or Alt+F2 → 'r' on X11."

# Live reload without logging out. GNOME 45+ caches an extension's ES modules
# for the life of the Shell, so re-enabling the same UUID can never pick up new
# code; a fresh UUID has fresh module URLs and loads what is on disk now. The
# Shell does not watch the extensions directory either, so the new copy is
# handed to its extension manager over org.gnome.Shell.Eval, which answers only
# while Looking Glass's Unsafe Mode is on (Alt+F2, `lg`, the toggle in its top
# bar). Both copies share the schema and the usage file, so exactly one of them
# is enabled at any time: this disables the production UUID and any earlier dev
# copy before enabling the new one.
reload: build
	@$(REMOVE_DEV_COPIES)
	@new=screen-time-dev-$$(date +%s)@gnome-screen-time; \
	dir=$(EXTENSIONS_DIR)/$$new; tmp=$$(mktemp -d); \
	cp -r $(SRC_DIR)/* $$tmp/ && \
	python3 -c 'import json,sys; p,u=sys.argv[1:3]; m=json.load(open(p)); m["uuid"]=u; m["name"]+=" (dev)"; json.dump(m,open(p,"w"),indent=4)' $$tmp/metadata.json $$new && \
	mv $$tmp $$dir || exit 1; \
	gnome-extensions disable $(UUID) 2>/dev/null || true; \
	js="const M = Main.extensionManager; const ext = M.createExtensionObject('$$new', Gio.File.new_for_path('$$dir'), ExtensionUtils.ExtensionType.PER_USER); M.loadExtension(ext).then(() => M.enableExtension('$$new')).catch(e => logError(e, 'reload')); 'queued'"; \
	out=$$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$$js" 2>&1); \
	case "$$out" in \
	  *true*) ;; \
	  "(false, '')") echo "Shell refused Eval. Turn Unsafe Mode on once per login: Alt+F2, type lg, click the Unsafe Mode toggle in Looking Glass's top bar. Then rerun make reload."; \
	    rm -rf $$dir; gnome-extensions enable $(UUID); exit 1;; \
	  *) echo "Eval failed: $$out"; rm -rf $$dir; gnome-extensions enable $(UUID); exit 1;; \
	esac; \
	sleep 1; state=$$(gnome-extensions info $$new 2>/dev/null | sed -n 's/^ *State: //p'); \
	echo "Loaded $$new (state: $${state:-unknown})"; \
	echo "Errors, if any: journalctl --user -o cat -b 0 /usr/bin/gnome-shell | grep -A5 $$new | tail -20"

# Back to the production copy: remove every dev copy, re-enable the real UUID.
unreload:
	@$(REMOVE_DEV_COPIES)
	@gnome-extensions enable $(UUID) && echo "Enabled $(UUID)"

uninstall:
	@rm -rf $(EXTENSION_DIR)
	@echo "Uninstalled $(UUID)."

# Distributable archive for extensions.gnome.org.
# NOTE: per EGO-P-006, compiled schemas MUST NOT be shipped for shell-version
# 45+; GNOME Shell compiles them at install time. This target therefore does
# NOT depend on `build`, and excludes any *.compiled defensively.
pack:
	@mkdir -p $(DIST_DIR)
	@rm -f $(PACK_FILE)
	@cd $(SRC_DIR) && zip -qr ../$(PACK_FILE) . -x "schemas/*.compiled" "*.compiled"
	@# The zip is a binary distribution of GPL source, so it carries its licence.
	@zip -q -j $(PACK_FILE) LICENSE
	@echo "Packed: $(PACK_FILE)"

# Browser companion: one WebExtension source, built for Brave and Chrome
# (unpacked directory plus zip) and for Firefox and Zen (xpi). Never part of
# `pack`.
companion-build:
	@$(COMPANION_TOOL) build

# Registers the native host with Brave, Chrome and Zen; Firefox reads Zen's
# manifest from the same directory. The manifests point at the script in
# this checkout, so moving the repository means re-running this.
companion-install:
	@chmod +x $(HOST_SCRIPT)
	@mkdir -p $(BRAVE_HOSTS_DIR) $(CHROME_HOSTS_DIR) $(ZEN_HOSTS_DIR)
	@brave_id=$$($(COMPANION_TOOL) extension-id brave) && test -n "$$brave_id" && \
	chrome_id=$$($(COMPANION_TOOL) extension-id chrome) && test -n "$$chrome_id" && \
	sed -e 's|@PATH@|$(HOST_SCRIPT)|' -e "s|@ID@|$$brave_id|" companion/host/chromium.json.in > $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST) && \
	sed -e 's|@PATH@|$(HOST_SCRIPT)|' -e "s|@ID@|$$chrome_id|" companion/host/chromium.json.in > $(CHROME_HOSTS_DIR)/$(HOST_MANIFEST) && \
	sed -e 's|@PATH@|$(HOST_SCRIPT)|' companion/host/zen.json.in > $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST) && \
	python3 -m json.tool $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST) >/dev/null && \
	python3 -m json.tool $(CHROME_HOSTS_DIR)/$(HOST_MANIFEST) >/dev/null && \
	python3 -m json.tool $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST) >/dev/null && \
	$(COMPANION_TOOL) ping && \
	echo "Host registered for Brave ($$brave_id), Chrome ($$chrome_id) and Zen." && \
	echo "Brave: brave://extensions, Developer mode, Load unpacked, pick dist/webext-brave" && \
	echo "Chrome: chrome://extensions, Developer mode, Load unpacked, pick dist/webext-chrome" && \
	echo "Zen:   about:config xpinstall.signatures.required=false, then open dist/screen-time-zen.xpi" && \
	echo "Firefox: about:debugging, Load Temporary Add-on, pick dist/webext-firefox/manifest.json (same host manifest as Zen)"

companion-uninstall:
	@rm -f $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST) $(CHROME_HOSTS_DIR)/$(HOST_MANIFEST) $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST)
	@echo "Host manifests removed."

# Syntax-check every module. `gjs -c` runs a string and does NOT check syntax;
# `gjs -m` does. Import errors for resource:///org/gnome/... and missing Shell
# typelibs are expected outside a live Shell, so only SyntaxError counts.
# stdin comes from /dev/null because this runs each module: the native
# messaging host reads stdin until it closes, and would otherwise block here.
# src/timesheet.js is skipped: running it would open the Timesheet window.
check:
	@fail=0; \
	for f in $(filter-out $(SRC_DIR)/timesheet.js,$(wildcard $(SRC_DIR)/*.js)) $(wildcard companion/webext/*.js) $(wildcard companion/host/*.js); do \
		if gjs -m "$$f" < /dev/null 2>&1 | grep -qi "SyntaxError"; then \
			echo "SyntaxError in $$f"; fail=1; \
		fi; \
	done; \
	python3 -m json.tool $(SRC_DIR)/metadata.json >/dev/null || fail=1; \
	python3 -m json.tool companion/webext/manifest.json >/dev/null || fail=1; \
	python3 -m json.tool companion/webext/manifest.gecko.json >/dev/null || fail=1; \
	if [ $$fail -eq 0 ]; then echo "check: clean"; else exit 1; fi

# Unit tests for the modules that do not need a live Shell. run.js points
# XDG_DATA_HOME at a scratch directory itself, so a run never touches the real
# usage.json.
test:
	@gjs -m tests/run.js
	@tests/install.sh

lint:
	@if command -v eslint >/dev/null 2>&1; then \
		eslint $(SRC_DIR)/*.js; \
	else \
		echo "eslint not found. Install with: npm install -g eslint"; \
	fi

clean:
	@rm -rf $(DIST_DIR)
	@rm -f $(SCHEMAS_DIR)/*.compiled

restart:
	@if [ "$$XDG_SESSION_TYPE" = "x11" ]; then \
		busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…")'; \
	else \
		echo "On Wayland, log out and back in to reload extensions."; \
	fi
