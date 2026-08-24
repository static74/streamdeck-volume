PLUGIN := com.sb.output-volume.sdPlugin
PLUGINS_DIR := $(HOME)/Library/Application Support/com.elgato.StreamDeck/Plugins

build: helper deps

helper:
	swiftc -O helper/audioctl.swift -o $(PLUGIN)/bin/audioctl

deps:
	cd $(PLUGIN) && npm install --omit=dev

test:
	node --test test/model.test.js

install: build
	ln -sfn "$(CURDIR)/$(PLUGIN)" "$(PLUGINS_DIR)/$(PLUGIN)"

restart:
	osascript -e 'quit app "Elgato Stream Deck"' || true
	sleep 2
	open -a "Elgato Stream Deck"

.PHONY: build helper deps test install restart
