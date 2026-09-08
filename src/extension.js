import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore } from './usageStore.js';
import { LimitNotifier } from './limitNotifier.js';
import { ActivitySourceRegistry, ZellijSource } from './activitySources.js';
import { BrowserSource } from './browserSource.js';
import { DbusService } from './dbusService.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._indicator = new PanelIndicator();
        this._indicator.addToPanel(this.uuid);
        this._popup = new PopupWidget(this._indicator.menu, this._store,
            this._settings, () => this.openPreferences());

        // The browser companion pushes into this source over D-Bus; the same
        // instance sits in the registry the tracker reads from.
        let browserSource = new BrowserSource();
        this._dbus = new DbusService(browserSource);
        this._tracker = new UsageTracker(this._store, this._settings,
            new ActivitySourceRegistry([new ZellijSource(), browserSource]));
        this._limitNotifier = new LimitNotifier(this._settings);

        this._store.onChange = (appId, displayName, seconds) => {
            this._indicator.setTotal(this._store.getTodayTotal());
            if (appId)
                this._limitNotifier.checkLimit(appId, displayName, seconds);
        };
        this._indicator.setTotal(this._store.getTodayTotal());

        this._settings.connectObject(
            'changed::show-total-in-panel', () => this._syncPanelLabel(), this);
        this._syncPanelLabel();
    }

    _syncPanelLabel() {
        this._indicator.setShowTotal(
            this._settings.get_boolean('show-total-in-panel'));
    }

    disable() {
        this._settings.disconnectObject(this);
        this._tracker?.destroy();      // destroys the registry and its sources
        this._tracker = null;
        this._dbus?.destroy();
        this._dbus = null;
        this._popup?.destroy();
        this._popup = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._limitNotifier = null;
        this._store?.destroy();
        this._store = null;
        this._settings = null;
    }
}
