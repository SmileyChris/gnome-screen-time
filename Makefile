UUID            = screen-time@gnome-screen-time
VERSION         = 1.1.0
EXTENSION_DIR   = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR         = src
SCHEMAS_DIR     = $(SRC_DIR)/schemas
DIST_DIR        = dist
PACK_FILE       = $(DIST_DIR)/$(UUID).shell-extension.zip
COMPANION_TOOL  = python3 companion/tools/build.py
HOST_SCRIPT     = $(abspath companion/host/screen-time-host.js)
HOST_MANIFEST   = org.gnome.shell.extensions.screen_time.json
BRAVE_HOSTS_DIR = $(HOME)/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts
ZEN_HOSTS_DIR   = $(HOME)/.mozilla/native-messaging-hosts

.PHONY: all build schemas install uninstall pack companion-build companion-install companion-uninstall lint check test clean restart

all: build

# Compile GSettings schemas
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

build: schemas

# Install to the local GNOME Shell extensions directory. Copying the whole of
# src/ means a new module never has to be registered anywhere. If it is in
# src/, it ships.
install: build
	@mkdir -p $(EXTENSION_DIR)
	@cp -r $(SRC_DIR)/* $(EXTENSION_DIR)/
	@echo "Installed to $(EXTENSION_DIR)"
	@echo "Reload GNOME Shell: log out/in on Wayland, or Alt+F2 → 'r' on X11."

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

# Browser companion: one WebExtension source, built for Brave (unpacked
# directory plus zip) and Zen (xpi). Never part of `pack`.
companion-build:
	@$(COMPANION_TOOL) build

# Registers the native host with Brave and Zen. The manifests point at the
# script in this checkout, so moving the repository means re-running this.
companion-install:
	@chmod +x $(HOST_SCRIPT)
	@mkdir -p $(BRAVE_HOSTS_DIR) $(ZEN_HOSTS_DIR)
	@id=$$($(COMPANION_TOOL) extension-id); \
	sed -e 's|@PATH@|$(HOST_SCRIPT)|' -e "s|@BRAVE_ID@|$$id|" companion/host/brave.json.in > $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST); \
	sed -e 's|@PATH@|$(HOST_SCRIPT)|' companion/host/zen.json.in > $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST); \
	python3 -m json.tool $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST) >/dev/null; \
	python3 -m json.tool $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST) >/dev/null; \
	$(COMPANION_TOOL) ping; \
	echo "Host registered for Brave (extension id $$id) and Zen."; \
	echo "Brave: brave://extensions, Developer mode, Load unpacked, pick dist/webext-brave"; \
	echo "Zen:   about:config xpinstall.signatures.required=false, then open dist/screen-time-zen.xpi"

companion-uninstall:
	@rm -f $(BRAVE_HOSTS_DIR)/$(HOST_MANIFEST) $(ZEN_HOSTS_DIR)/$(HOST_MANIFEST)
	@echo "Host manifests removed."

# Syntax-check every module. `gjs -c` runs a string and does NOT check syntax;
# `gjs -m` does. Import errors for resource:///org/gnome/... and missing Shell
# typelibs are expected outside a live Shell, so only SyntaxError counts.
# stdin comes from /dev/null because this runs each module: the native
# messaging host reads stdin until it closes, and would otherwise block here.
check:
	@fail=0; \
	for f in $(SRC_DIR)/*.js $(wildcard companion/webext/*.js) $(wildcard companion/host/*.js); do \
		if gjs -m "$$f" < /dev/null 2>&1 | grep -qi "SyntaxError"; then \
			echo "SyntaxError in $$f"; fail=1; \
		fi; \
	done; \
	python3 -m json.tool $(SRC_DIR)/metadata.json >/dev/null || fail=1; \
	python3 -m json.tool companion/webext/manifest.json >/dev/null || fail=1; \
	python3 -m json.tool companion/webext/manifest.gecko.json >/dev/null || fail=1; \
	if [ $$fail -eq 0 ]; then echo "check: clean"; else exit 1; fi

# Unit tests for the pure modules. run.js redirects XDG_DATA_HOME to a scratch
# directory itself, so this never touches the real usage.json.
test:
	@gjs -m tests/run.js

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
