import { Toolbar, ToolbarButton } from '@jupyterlab/apputils';

import { IChangedArgs } from '@jupyterlab/coreutils';

import { ServerConnection } from '@jupyterlab/services';

import { JSONObject, JSONExt } from '@phosphor/coreutils';

import { Drag, IDragEvent } from '@phosphor/dragdrop';

import { Message } from '@phosphor/messaging';

import { ISignal, Signal } from '@phosphor/signaling';

import { Widget, PanelLayout } from '@phosphor/widgets';

import { showScalingDialog } from './scaling';

import * as React from 'react';
import * as ReactDOM from 'react-dom';

const REFRESH_INTERVAL = 5000;

/**
 * A widget for hosting Dask cluster management.
 */
export class DaskClusterManager extends Widget {
  /**
   * Create a new Dask cluster manager.
   */
  constructor(options: DaskClusterManager.IOptions) {
    super();
    this.addClass('dask-DaskClusterManager');

    this._serverSettings = ServerConnection.makeSettings();
    this._injectClientCodeForCluster = options.injectClientCodeForCluster;

    // A function to set the active cluster.
    this._setActiveById = (id: string) => {
      const cluster = this._clusters.find(c => c.id === id);
      if (!cluster) {
        return;
      }
      options.setDashboardUrl(`dask/dashboard/${cluster.id}`);

      const old = this._activeCluster;
      if (old && old.id === cluster.id) {
        return;
      }
      this._activeCluster = cluster;
      this._activeClusterChanged.emit({
        name: 'cluster',
        oldValue: old,
        newValue: cluster
      });
      this.update();
    };

    const layout = (this.layout = new PanelLayout());

    this._clusterListing = new Widget();
    this._clusterListing.addClass('dask-ClusterListing');

    // Create the toolbar.
    const toolbar = new Toolbar<Widget>();

    // Make a label widget for the toolbar.
    const toolbarLabel = new Widget();
    toolbarLabel.node.textContent = 'CLUSTERS';
    toolbarLabel.addClass('dask-DaskClusterManager-label');
    toolbar.addItem('label', toolbarLabel);

    // Make a refresh button for the toolbar.
    toolbar.addItem(
      'refresh',
      new ToolbarButton({
        iconClassName: 'jp-RefreshIcon jp-Icon jp-Icon-16',
        onClick: () => {
          this._updateClusterList();
        },
        tooltip: 'Refresh Cluster List'
      })
    );

    // Make a shutdown button for the toolbar.
    toolbar.addItem(
      'new',
      new ToolbarButton({
        iconClassName: 'jp-AddIcon jp-Icon jp-Icon-16',
        label: 'NEW',
        onClick: () => {
          this._launchCluster();
        },
        tooltip: 'Start New Dask Cluster'
      })
    );

    layout.addWidget(toolbar);
    layout.addWidget(this._clusterListing);

    // Do an initial refresh of the cluster list.
    this._updateClusterList();
    // Also refresh periodically.
    window.setInterval(() => {
      this._updateClusterList();
    }, REFRESH_INTERVAL);
  }

  /**
   * The currently selected cluster, or undefined if there is none.
   */
  get activeCluster(): IClusterModel | undefined {
    return this._activeCluster;
  }

  /**
   * Set an active cluster by id.
   */
  setActiveCluster(id: string): void {
    this._setActiveById(id);
  }

  /**
   * A signal that is emitted when an active cluster changes.
   */
  get activeClusterChanged(): ISignal<
    this,
    IChangedArgs<IClusterModel | undefined>
  > {
    return this._activeClusterChanged;
  }

  /**
   * Get the current clusters known to the manager.
   */
  get clusters(): IClusterModel[] {
    return this._clusters;
  }

  /**
   * Refresh the current list of clusters.
   */
  async refresh(): Promise<void> {
    await this._updateClusterList();
  }

  /**
   * Start a new cluster.
   */
  async start(): Promise<IClusterModel> {
    const cluster = await this._launchCluster();
    return cluster;
  }

  /**
   * Stop a cluster by ID.
   */
  async stop(id: string): Promise<void> {
    const cluster = this._clusters.find(c => c.id === id);
    if (!cluster) {
      throw Error(`Cannot find cluster ${id}`);
    }
    await this._stopById(id);
  }

  /**
   * Scale a cluster by ID.
   */
  async scale(id: string): Promise<IClusterModel> {
    const cluster = this._clusters.find(c => c.id === id);
    if (!cluster) {
      throw Error(`Cannot find cluster ${id}`);
    }
    const newCluster = await this._scaleById(id);
    return newCluster;
  }

  /**
   * Handle an update request.
   */
  protected onUpdateRequest(msg: Message): void {
    // Don't bother if the sidebar is not visible
    if (!this.isVisible) {
      return;
    }

    ReactDOM.render(
      <ClusterListing
        clusters={this._clusters}
        activeClusterId={(this._activeCluster && this._activeCluster.id) || ''}
        scaleById={(id: string) => {
          return this._scaleById(id);
        }}
        stopById={(id: string) => {
          return this._stopById(id);
        }}
        setActiveById={this._setActiveById}
        injectClientCodeForCluster={this._injectClientCodeForCluster}
      />,
      this._clusterListing.node
    );
  }

  /**
   * Rerender after showing.
   */
  protected onAfterShow(msg: Message): void {
    this.update();
  }

  /**
   * Handle `after-attach` messages for the widget.
   */
  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    let node = this.node;
    node.addEventListener('p-dragenter', this);
    node.addEventListener('p-dragleave', this);
    node.addEventListener('p-dragover', this);
    node.addEventListener('mousedown', this);
  }

  /**
   * Handle `before-detach` messages for the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    let node = this.node;
    node.removeEventListener('p-dragenter', this);
    node.removeEventListener('p-dragleave', this);
    node.removeEventListener('p-dragover', this);
    node.removeEventListener('mousedown', this);
    document.removeEventListener('mouseup', this, true);
    document.removeEventListener('mousemove', this, true);
  }

  /**
   * Handle the DOM events for the directory listing.
   *
   * @param event - The DOM event sent to the widget.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the panel's DOM node. It should
   * not be called directly by user code.
   */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'mousedown':
        this._evtMousedown(event as MouseEvent);
        break;
      case 'mouseup':
        this._evtMouseup(event as MouseEvent);
        break;
      case 'mousemove':
        this._evtMousemove(event as MouseEvent);
        break;
      case 'p-dragenter':
        this._evtDragEnter(event as IDragEvent);
        break;
      case 'p-dragleave':
        this._evtDragLeave(event as IDragEvent);
        break;
      case 'p-dragover':
        this._evtDragOver(event as IDragEvent);
        break;
      default:
        break;
    }
  }

  /**
   * Launch a new cluster on the server.
   */
  private async _launchCluster(): Promise<IClusterModel> {
    const response = await ServerConnection.makeRequest(
      `${this._serverSettings.baseUrl}dask/clusters`,
      { method: 'PUT' },
      this._serverSettings
    );
    if (response.status !== 200) {
      throw new Error('Failed to start Dask cluster');
    }
    const model = (await response.json()) as IClusterModel;
    await this._updateClusterList();
    return model;
  }

  /**
   * Refresh the list of clusters on the server.
   */
  private async _updateClusterList(): Promise<void> {
    const response = await ServerConnection.makeRequest(
      `${this._serverSettings.baseUrl}dask/clusters`,
      {},
      this._serverSettings
    );
    const data = (await response.json()) as IClusterModel[];
    this._clusters = data;

    // Check to see if the active cluster still exits.
    // If it doesn't, or if there is no active cluster,
    // select the first one.
    const active = this._clusters.find(
      c => c.id === (this._activeCluster && this._activeCluster.id)
    );
    if (!active) {
      const id = (this._clusters[0] && this._clusters[0].id) || '';
      this._setActiveById(id);
    }
    this.update();
  }

  /**
   * Stop a cluster by its id.
   */
  private async _stopById(id: string): Promise<void> {
    const response = await ServerConnection.makeRequest(
      `${this._serverSettings.baseUrl}dask/clusters/${id}`,
      { method: 'DELETE' },
      this._serverSettings
    );
    if (response.status !== 204) {
      throw new Error(`Failed to close Dask cluster ${id}`);
    }
    await this._updateClusterList();
  }

  /**
   * Scale a cluster by its id.
   */
  private async _scaleById(id: string): Promise<IClusterModel> {
    const cluster = this._clusters.find(c => c.id === id);
    if (!cluster) {
      throw Error(`Failed to find cluster ${id} to scale`);
    }
    const update = await showScalingDialog(cluster);
    if (JSONExt.deepEqual(update, cluster)) {
      // If the user canceled, or the model is identical don't try to update.
      return Promise.resolve(cluster);
    }

    const response = await ServerConnection.makeRequest(
      `${this._serverSettings.baseUrl}dask/clusters/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(update)
      },
      this._serverSettings
    );
    if (response.status !== 200) {
      throw new Error(`Failed to scale cluster ${id}`);
    }
    const model = (await response.json()) as IClusterModel;
    await this._updateClusterList();
    return model;
  }

  private _clusterListing: Widget;
  private _clusters: IClusterModel[] = [];
  private _activeCluster: IClusterModel | undefined;
  private _setActiveById: (id: string) => void;
  private _injectClientCodeForCluster: (model: IClusterModel) => void;
  private _serverSettings: ServerConnection.ISettings;
  private _activeClusterChanged = new Signal<
    this,
    IChangedArgs<IClusterModel | undefined>
  >(this);
}

/**
 * A namespace for DasClusterManager statics.
 */
export namespace DaskClusterManager {
  /**
   * Options for the constructor.
   */
  export interface IOptions {
    /**
     * A callback to set the dashboard url.
     */
    setDashboardUrl: (url: string) => void;

    /**
     * A callback to inject client connection cdoe.
     */
    injectClientCodeForCluster: (model: IClusterModel) => void;
  }
}

/**
 * A React component for a launcher button listing.
 */
function ClusterListing(props: IClusterListingProps) {
  let listing = props.clusters.map(cluster => {
    return (
      <ClusterListingItem
        isActive={cluster.id === props.activeClusterId}
        key={cluster.id}
        cluster={cluster}
        scale={() => props.scaleById(cluster.id)}
        stop={() => props.stopById(cluster.id)}
        setActive={() => props.setActiveById(cluster.id)}
        injectClientCode={() => props.injectClientCodeForCluster(cluster)}
      />
    );
  });

  // Return the JSX component.
  return (
    <div>
      <ul className="dask-ClusterListing-list">{listing}</ul>
    </div>
  );
}

/**
 * Props for the cluster listing component.
 */
export interface IClusterListingProps {
  /**
   * A list of dashboard items to render.
   */
  clusters: IClusterModel[];

  /**
   * The id of the active cluster.
   */
  activeClusterId: string;

  /**
   * A function for stopping a cluster by ID.
   */
  stopById: (id: string) => Promise<void>;

  /**
   * Scale a cluster by id.
   */
  scaleById: (id: string) => Promise<IClusterModel>;

  /**
   * A callback to set the active cluster by id.
   */
  setActiveById: (id: string) => void;

  /**
   * A callback to inject client code for a cluster.
   */
  injectClientCodeForCluster: (model: IClusterModel) => void;
}

/**
 * A TSX functional component for rendering a single running cluster.
 */
function ClusterListingItem(props: IClusterListingItemProps) {
  const { cluster, isActive, setActive, scale, stop, injectClientCode } = props;
  let itemClass = 'dask-ClusterListingItem';
  itemClass = isActive ? `${itemClass} jp-mod-active` : itemClass;

  let minimum: JSX.Element | null = null;
  let maximum: JSX.Element | null = null;
  if (cluster.adapt) {
    minimum = (
      <div className="dask-ClusterListingItem-stats">
        Minimum Workers: {cluster.adapt.minimum}
      </div>
    );
    maximum = (
      <div className="dask-ClusterListingItem-stats">
        Maximum Workers: {cluster.adapt.maximum}
      </div>
    );
  }

  return (
    <li
      className={itemClass}
      data-cluster-id={cluster.id}
      onClick={evt => {
        setActive();
        evt.stopPropagation();
      }}
    >
      <div className="dask-ClusterListingItem-title">{cluster.name}</div>
      <div
        className="dask-ClusterListingItem-link"
        title={cluster.scheduler_address}
      >
        Scheduler Address: {cluster.scheduler_address}
      </div>
      <div className="dask-ClusterListingItem-link">
        Dashboard URL:{' '}
        <a
          target="_blank"
          href={cluster.dashboard_link}
          title={cluster.dashboard_link}
        >
          {cluster.dashboard_link}
        </a>
      </div>
      <div className="dask-ClusterListingItem-stats">
        Number of Cores: {cluster.cores}
      </div>
      <div className="dask-ClusterListingItem-stats">
        Memory: {cluster.memory}
      </div>
      <div className="dask-ClusterListingItem-stats">
        Number of Workers: {cluster.workers}
      </div>
      {minimum}
      {maximum}
      <div className="dask-ClusterListingItem-button-panel">
        <button
          className="dask-ClusterListingItem-button dask-ClusterListingItem-code dask-CodeIcon jp-mod-styled"
          onClick={evt => {
            injectClientCode();
            evt.stopPropagation();
          }}
          title={`Inject client code for ${cluster.name}`}
        />
        <button
          className="dask-ClusterListingItem-button dask-ClusterListingItem-scale jp-mod-styled"
          onClick={evt => {
            scale();
            evt.stopPropagation();
          }}
          title={`Rescale ${cluster.name}`}
        >
          SCALE
        </button>
        <button
          className="dask-ClusterListingItem-button dask-ClusterListingItem-stop jp-mod-styled"
          onClick={evt => {
            stop();
            evt.stopPropagation();
          }}
          title={`Shutdown ${cluster.name}`}
        >
          SHUTDOWN
        </button>
      </div>
    </li>
  );
}

/**
 * Props for the cluster listing component.
 */
export interface IClusterListingItemProps {
  /**
   * A cluster model to render.
   */
  cluster: IClusterModel;

  /**
   * Whether the cluster is currently active (i.e., if
   * it is being displayed in the dashboard).
   */
  isActive: boolean;

  /**
   * A function for scaling the cluster.
   */
  scale: () => Promise<IClusterModel>;

  /**
   * A function for stopping the cluster.
   */
  stop: () => Promise<void>;

  /**
   * A callback function to set the active cluster.
   */
  setActive: () => void;

  /**
   * A callback to inject client code into an editor.
   */
  injectClientCode: () => void;
}

/**
 * An interface for a JSON-serializable representation of a cluster.
 */
export interface IClusterModel extends JSONObject {
  /**
   * A unique string ID for the cluster.
   */
  id: string;

  /**
   * A display name for the cluster.
   */
  name: string;

  /**
   * A URI for the dask scheduler.
   */
  scheduler_address: string;

  /**
   * A URL for the Dask dashboard.
   */
  dashboard_link: string;

  /**
   * Total number of cores used by the cluster.
   */
  cores: number;

  /**
   * Total memory used by the cluster, as a human-readable string.
   */
  memory: string;

  /**
   * The number of workers for the cluster.
   */
  workers: number;

  /**
   * If adaptive is enabled for the cluster, this contains an object
   * with the minimum and maximum number of workers. Otherwise it is `null`.
   */
  adapt: null | { minimum: number; maximum: number };
}
