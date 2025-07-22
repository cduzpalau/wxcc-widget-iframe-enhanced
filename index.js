import { Desktop } from '@wxcc-desktop/sdk';

// Define a logger for debug/info output
const logger = Desktop.logger.createLogger('AGENTSDK-widget-logger');
let debugMode = false;

class IframeComponent extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.state = { defaultAuxCode: 0 };
    this._onMessage = this._onMessage.bind(this);
    this.interactionId = null;
    this._isSdkInitialized = false; // Add a flag to track SDK initialization status
    this._pendingWrapups = new Map(); // Map to store {interactionId: wrapupCodeId} for pending wrapups
    this._handleInteractionStateChange = this._handleInteractionStateChange.bind(this); // Bind the handler
    this.defaultWrapCode = null; // Instance property for the default wrap code
  }

  connectedCallback() {
    this._renderIframe();
    window.addEventListener("message", this._onMessage, false);
    window.parentFuncChgState = (message) => this.changeState(message);
    this._initializeSdkAndData();
  }

  disconnectedCallback() {
    Desktop.agentContact.removeAllEventListeners();
    Desktop.agentContact.removeEventListener('interaction:stateChanged', this._handleInteractionStateChange); // Remove the new listener
    window.removeEventListener("message", this._onMessage, false);
    if (window.parentFuncChgState) {
      delete window.parentFuncChgState;
    }
    this._isSdkInitialized = false;
    this._pendingWrapups.clear(); // Clear pending wrapups on disconnect
  }

  async _initializeSdkAndData() {
    try {
      logger.info('Starting Desktop SDK initialization and data fetch...');
      Desktop.config.init();

      // Add the interaction state change listener here, after SDK init
      Desktop.agentContact.addEventListener('interaction:stateChanged', this._handleInteractionStateChange);
      logger.info('Added interaction:stateChanged listener.');

      await new Promise(resolve => {
        const handleAgentStateInfoUpdate = () => {
          if (Desktop.agentStateInfo?.latestData?.idleCodes) {
            Desktop.agentStateInfo.removeEventListener('updated', handleAgentStateInfoUpdate);
            resolve();
          }
        };
        Desktop.agentStateInfo.addEventListener('updated', handleAgentStateInfoUpdate);
        if (Desktop.agentStateInfo?.latestData?.idleCodes) {
          Desktop.agentStateInfo.removeEventListener('updated', handleAgentStateInfoUpdate);
          resolve();
        }
      });
      this._isSdkInitialized = true;
      logger.info('Desktop SDK and agent data initialized successfully.');
      this._findDefaultAuxCode();
    } catch (error) {
      logger.error("Error during Desktop SDK initialization or data fetch:", error);
    }
  }

  _findDefaultAuxCode() {
    const idleCodes = Desktop?.agentStateInfo?.latestData?.idleCodes || [];
    if (idleCodes.length > 0) {
      const auxCount = idleCodes.length;
      let i = 0;
      while (i <= auxCount - 1) {
        logger.info('AuxCode list ', idleCodes[i].id);
        if (idleCodes[i].isDefault === true) {
          this.state.defaultAuxCode = idleCodes[i].id;
          logger.info(' default aux found ', this.state.defaultAuxCode);
          break;
        }
        i++;
      }
    } else {
      logger.info('idleCodes data is empty or was undefined/null and converted to an empty array.');
    }
  }

  async getInteractionId() {
    const currentTaskMap = await Desktop.actions.getTaskMap();
    for (const iterator of currentTaskMap) {
      const interId = iterator[1].interactionId;
      return interId; // Returns the interactionId of the first task found
    }
    return null; // Return null if no interactionId is found
  }

  /**
   * Handles interaction state changes to apply wrap-up codes.
   * @param {object} payload - The event payload from 'interaction:stateChanged'.
   * @param {string} payload.interactionId - The ID of the interaction.
   * @param {string} payload.newState - The new state of the interaction.
   */
  async _handleInteractionStateChange(payload) {
    const { interactionId, newState } = payload;
    logger.info(`Interaction ${interactionId} state changed to: ${newState}`);

    if (newState === 'Wrapup') {
      const wrapupCodeId = this._pendingWrapups.get(interactionId);
      if (wrapupCodeId) {
        logger.info(`Interaction ${interactionId} entered Wrapup state. Attempting to apply wrap-up code: ${wrapupCodeId}`);
        try {
          const wrapupResponse = await Desktop.agentContact.wrapup({
            interactionId,
            wrapupCodeId
          });
          logger.info(`Wrap-up code '${wrapupCodeId}' applied successfully for interaction ${interactionId}: ` + JSON.stringify(wrapupResponse));
        } catch (wrapupError) {
          // Improved error logging
          logger.error(`Error applying wrap-up code '${wrapupCodeId}' for interaction ${interactionId}:`,
            wrapupError.message || wrapupError.toString(), wrapupError);
        } finally {
          this._pendingWrapups.delete(interactionId); // Always remove after attempt
        }
      } else {
        logger.info(`Interaction ${interactionId} entered Wrapup state, but no pending wrap-up code was found.`);
      }
    }
    // You might also want to clear pending wrapups if the state goes to 'Closed' or 'Ended'
    // without hitting 'Wrapup' (e.g., if the call was force-closed or errored out).
    if (newState === 'Closed' || newState === 'Ended') {
        if (this._pendingWrapups.has(interactionId)) {
            logger.warn(`Interaction ${interactionId} reached ${newState} state without hitting Wrapup. Clearing pending wrap-up code.`);
            this._pendingWrapups.delete(interactionId);
        }
    }
  }


  /**
   * Ends the current call and queues a wrap-up code to be applied when the interaction enters the Wrapup state.
   * @param {string} [wrapupCodeId] - The ID of the wrap-up code to apply.
   */
  async endCall(wrapupCodeId = null) {
    let interactionId = await this.getInteractionId();
    if (!interactionId) {
      logger.warn("No active interaction ID found to end the call.");
      return;
    }

    // Store the wrapupCodeId for later application when the state changes
    if (wrapupCodeId) {
      this._pendingWrapups.set(interactionId, wrapupCodeId);
      logger.info(`Queued wrap-up code '${wrapupCodeId}' for interaction ${interactionId}. Will apply on 'Wrapup' state change.`);
    }

    try {
      // End the call
      const endResponse = await Desktop.agentContact.end({
        interactionId,
        data: {
          mediaResourceId: interactionId // This might be optional or specific to your setup
        }
      });
      logger.info("Call end request sent successfully for interaction: " + interactionId + JSON.stringify(endResponse));

    } catch (error) {
      logger.error("Error ending call for interaction " + interactionId + ":", error);
      // If ending the call fails, remove the pending wrap-up as it won't be applied
      if (wrapupCodeId) {
        this._pendingWrapups.delete(interactionId);
        logger.warn(`Removed pending wrap-up code for ${interactionId} due to call end failure.`);
      }
    }
  }

  async changeState(state) {
    if (!this._isSdkInitialized) {
      logger.warn('Attempted to change state before Desktop SDK was fully initialized. Operation skipped.');
      return;
    }

    if (debugMode) {
      alert('changeState called with state: ' + state);
    }
    logger.info('changeState called with state: ' + state);
    switch (state) {
      case 'Available': {
        try {
          const agentState = await Desktop.agentStateInfo.stateChange({
            state,
            auxCodeIdArray: '0',
          });
          logger.info('State Changed', agentState);
        } catch (error) {
          logger.error("Error changing state to 'Available':", error);
        }
        break;
      }
      case 'Idle': {
        try {
          await Desktop.agentStateInfo.stateChange({
            state,
            auxCodeIdArray: this.state.defaultAuxCode,
          });
          logger.info('State Changed to Idle', this.state.defaultAuxCode);
        } catch (error) {
          logger.error("Error changing state to 'Idle':", error);
        }
        break;
      }
      case 'EndTask': {
        try {
          // Use the instance's defaultWrapCode
          await this.endCall(this.defaultWrapCode);
          logger.info('Task end initiated via endCall method with queued wrap-up code.');

        } catch (error) {
          logger.error("Error ending task via endCall:", error);
        }
        break;
      }
      case 'EndTaskAvail': {
        let tostate = 'Available';
        try {
          await this.endCall(this.defaultWrapCode);
          logger.info('Task end initiated via endCall method with queued wrap-up code.');
          // State change should ideally happen after wrap-up, or be handled by the agent desktop logic
          // However, if you explicitly want to set state immediately after initiating end call:
          await Desktop.agentStateInfo.stateChange({
            state: tostate, // Use 'state' property name as expected by SDK
            auxCodeIdArray: '0',
          });
          logger.info('State Change to Available initiated.');

        } catch (error) {
          logger.error("Error ending task via endCall or changing state:", error);
        }
        break;
      }
      case 'EndTaskIdle': {
        let tostate = 'Idle';
        try {
          await this.endCall(this.defaultWrapCode);
          logger.info('Task end initiated via endCall method with queued wrap-up code.');
          // State change should ideally happen after wrap-up, or be handled by the agent desktop logic
          await Desktop.agentStateInfo.stateChange({
            state: tostate, // Use 'state' property name as expected by SDK
            auxCodeIdArray: this.state.defaultAuxCode,
          });
          logger.info('State Change to Idle initiated.');

        } catch (error) {
          logger.error("Error ending task via endCall or changing state:", error);
        }
        break;
      }
      default:
        logger.warn('Unknown state:', state);
    }
  }

  _onMessage(event) {
    const data = event.data;
    if (data && typeof data.func === "string" && typeof window[data.func] === "function") {
      window[data.func](data.message);
    }
  }

  _renderIframe() {
    const frameURL = this.getAttribute('frameURL');
    if (!frameURL) {
      logger.error("frameURL is required for <iframe-component>");
      return;
    }

    debugMode = this.getAttribute('debugMode');
    if (debugMode) {
      logger.info("NOTICE: Debugging is enabled");
    }

    // Assign the defaultWrap attribute value to the instance property
    this.defaultWrapCode = this.getAttribute('defaultWrap');
    if (!this.defaultWrapCode) {
      logger.info("NOTICE: No default wrap code provided in desktop layout attribute 'defaultWrap'.");
    }

    function flattenAndAppend(data, params, prefix = '') {
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        for (const key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            const newKey = prefix ? `${prefix}.${key}` : key;
            const value = data[key];
            flattenAndAppend(value, params, newKey);
          }
        }
      } else if (Array.isArray(data)) {
        data.forEach((item, index) => {
          const newKey = prefix ? `${prefix}.${index}` : String(index);
          flattenAndAppend(item, params, newKey);
        });
      } else {
        params.append(prefix, data);
      }
    }

    const params = new URLSearchParams();

    for (let attr of this.attributes) {
      // Exclude 'frameURL', 'debugMode', and 'defaultWrap' from the iframe URL parameters
      if (attr.name !== 'frameURL' && attr.name !== 'debugMode' && attr.name.toLowerCase() !== 'defaultwrap') {
        const attrValue = attr.value;
        if (typeof attrValue === 'object' && attrValue !== null) {
          flattenAndAppend(attrValue, params, attr.name);
        } else {
          params.append(attr.name, attrValue);
        }
      }
    }

    logger.info(params.toString());

    const html = `
      <style>
        iframe {
          width: 100%;
          height: 100%;
          border: none;
        }
      </style>
      <iframe src="${frameURL}?${params.toString()}"></iframe>
    `;

    this.shadowRoot.innerHTML = html;
  }
}

if (!customElements.get('iframe-component')) {
  customElements.define('iframe-component', IframeComponent);
}