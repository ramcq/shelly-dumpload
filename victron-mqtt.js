// Cerbo GX to Shelly Monitor Script - Simplified Version
// This script connects to a Cerbo GX via MQTT and updates Shelly virtual components
// with battery SOC and AC input status (connected or not)

// Configuration
let config = {
  // MQTT connection to Cerbo GX
  cerbo: {
    host: "192.168.1.71", // Cerbo GX IP address
    port: 1883,
    portalId: "c0847dc9a794", // VRM portal ID
    reconnectDelay: 5000 // ms to wait before reconnection attempt
  },
  // Topics to monitor (will be prefixed with N/<portalId>/)
  topics: {
    batterySOC: "system/0/Dc/Battery/Soc",
    acSource: "system/0/Ac/ActiveIn/Source" // 0=Unknown;1=Grid;2=Generator;3=Shore;240=Not connected
  },
  // Virtual component IDs - using higher numbers to avoid conflicts with frequency controller
  virtualComponents: {
    batterySOC: 210,     // Will be "number:210"
    acConnected: 211     // Will be "boolean:211"
  },
  // Debug mode
  debugMode: true
};

// Connection state tracking
let state = {
  connected: false,
  keepaliveTimer: null,
  reconnectTimer: null,
  lastKeepaliveId: null,
  mqttValues: {},
};

// Component handles
let batterySOCHandle = null;
let acConnectedHandle = null;

// Helper function for logging
function logDebug(message) {
  if (config.debugMode) {
    console.log("[DEBUG-CERBO] " + message);
  }
}

// Check if an array contains a value
function arrayContains(array, value) {
  for (let i = 0; i < array.length; i++) {
    if (array[i] === value) {
      return true;
    }
  }
  return false;
}

// Create or get all virtual components sequentially
function setupVirtualComponents(existingComponentKeys) {
  // Step 1: Create or get battery SOC component
  if (!arrayContains(existingComponentKeys, "number:" + config.virtualComponents.batterySOC)) {
    console.log("Creating battery SOC component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: config.virtualComponents.batterySOC,
      config: {
        name: "Battery SOC",
        default_value: 0,
        min: 0,
        max: 100,
        meta: {
          ui: {
            view: "label",
            unit: "%"
          }
        },
        persisted: false
      }
    });
  } else {
    logDebug("Battery SOC component already exists");
  }
  
  // Step 2: Create or get AC Connected component
  if (!arrayContains(existingComponentKeys, "boolean:" + config.virtualComponents.acConnected)) {
    console.log("Creating AC Connected component");
    Shelly.call("Virtual.Add", {
      type: "boolean",
      id: config.virtualComponents.acConnected,
      config: {
        name: "AC Input Connected",
        default_value: false,
        persisted: false,
        meta: {
          ui: {
            view: "label"
          }
        }
      }
    });
  } else {
    logDebug("AC Connected component already exists");
  }
  
  // Step 3: Create or get group component to make all components visible in the UI
  let groupId = 212; // Group component ID
  if (!arrayContains(existingComponentKeys, "group:" + groupId)) {
    console.log("Creating Cerbo GX Monitor group component");
    Shelly.call("Virtual.Add", {
      type: "group",
      id: groupId,
      config: {
        name: "Cerbo GX Monitor",
        components: [
          "number:" + config.virtualComponents.batterySOC, 
          "boolean:" + config.virtualComponents.acConnected
        ]
      }
    });
  }
  
  // Wait a moment to let the components initialize fully
  Timer.set(2000, false, function() {
    finishSetup();
  });
}

// Finish the setup process after creating components
function finishSetup() {
  logDebug("Finishing setup");
  
  // Try to get handles for all components
  try {
    batterySOCHandle = Virtual.getHandle("number:" + config.virtualComponents.batterySOC);
    acConnectedHandle = Virtual.getHandle("boolean:" + config.virtualComponents.acConnected);
    
    // Set initial values
    if (batterySOCHandle) {
      batterySOCHandle.setValue(0);
    }
    
    if (acConnectedHandle) {
      acConnectedHandle.setValue(false);
    }
    
    // Start MQTT connection
    connectMqtt();
  } catch (e) {
    console.log("Error in finishSetup: " + e.message);
    // Start monitoring even if there's an error with the components
    connectMqtt();
  }
}

// Update virtual components with the latest values
function updateComponents() {
  // Update battery SOC
  if (state.mqttValues.hasOwnProperty(config.topics.batterySOC)) {
    let socValue = state.mqttValues[config.topics.batterySOC]?.value;
    if (socValue !== undefined && socValue !== null) {
      // Update virtual component
      if (batterySOCHandle) {
        batterySOCHandle.setValue(socValue);
        logDebug("Updated battery SOC: " + socValue + "%");
      }
    }
  }
  
  // Update AC input status
  if (state.mqttValues.hasOwnProperty(config.topics.acSource)) {
    let acSource = state.mqttValues[config.topics.acSource]?.value;
    // AC Source: 0=Unknown; 1=Grid; 2=Generator; 3=Shore power; 240=Not connected
    let isConnected = (acSource !== null && acSource !== undefined && acSource !== 240);
    
    // Update virtual component
    if (acConnectedHandle) {
      acConnectedHandle.setValue(isConnected);
      logDebug("Updated AC connected: " + isConnected + " (Source: " + acSource + ")");
    }
  }
}

// Reset component values when disconnected
function resetComponents() {
  // For Boolean components, set to false (not null) as booleans can't hold null
  if (acConnectedHandle) {
    acConnectedHandle.setValue(false);
  }
  
  // For Number components, set to 0 rather than null
  if (batterySOCHandle) {
    batterySOCHandle.setValue(0);
  }
  
  logDebug("Reset component values due to disconnection");
}

// Process a message received from MQTT
function processMqttMessage(topic, message) {
  // Skip empty messages (device disappearance)
  if (message.length === 0) {
    logDebug("Empty message received for topic: " + topic);
    return;
  }
  
  try {
    let payload = JSON.parse(message);
    
    // Extract the relative topic (without the N/<portalId>/ prefix)
    let topicPrefix = "N/" + config.cerbo.portalId + "/";
    
    // Check if topic starts with prefix (Shelly doesn't have String.startsWith)
    if (topic.indexOf(topicPrefix) === 0) {
      let relativeTopic = topic.substring(topicPrefix.length);
      
      // Store value in our state
      state.mqttValues[relativeTopic] = payload;
      
      // Update components with new data
      updateComponents();
    }
  } catch (e) {
    console.log("Error processing message: " + e.message);
  }
}

// Handle when MQTT is connected
function handleMqttConnected() {
  console.log("Connected to MQTT broker");
  state.connected = true;
  
  // Subscribe to topics
  let topicPrefix = "N/" + config.cerbo.portalId + "/";
  for (let key in config.topics) {
    let topic = topicPrefix + config.topics[key];
    MQTT.subscribe(topic, processMqttMessage);
    logDebug("Subscribed to: " + topic);
  }
  
  // Send initial keepalive
  sendKeepalive(false);
  
  // Setup periodic keepalive
  if (state.keepaliveTimer) {
    Timer.clear(state.keepaliveTimer);
  }
  state.keepaliveTimer = Timer.set(30000, true, function() {
    sendKeepalive(true);
  });
}

// MQTT connection and subscription
function connectMqtt() {
  // Clear any pending reconnect timers
  if (state.reconnectTimer) {
    Timer.clear(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  
  // Check if MQTT is already enabled and connected
  let mqttStatus = Shelly.getComponentStatus("mqtt");
  if (mqttStatus && mqttStatus.connected === true) {
    logDebug("MQTT is already connected");
    if (!state.connected) {
      // We're connected but our internal state doesn't reflect that
      handleMqttConnected();
    }
    return;
  }
  
  if (state.connected) {
    // Our internal state says we're connected but MQTT says we're not
    // This is a discrepancy - reset our state
    logDebug("State discrepancy: internal state says connected but MQTT is disconnected");
    state.connected = false;
    resetComponents();
  }
  
  logDebug("Attempting to connect to MQTT broker at " + config.cerbo.host + ":" + config.cerbo.port);
  
  // Configure and enable MQTT if needed
  let mqttConfig = Shelly.getComponentConfig("mqtt");
  let needsConfig = false;
  
  if (!mqttConfig.enable) {
    needsConfig = true;
    logDebug("MQTT is disabled, enabling it");
  } else if (mqttConfig.server !== config.cerbo.host + ":" + config.cerbo.port) {
    needsConfig = true;
    logDebug("MQTT server doesn't match, reconfiguring");
  }
  
  if (needsConfig) {
    // Configure MQTT
    Shelly.call("MQTT.SetConfig", {
      config: {
        enable: true,
        server: config.cerbo.host + ":" + config.cerbo.port
      }
    }, function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error configuring MQTT: " + error_message);
        scheduleReconnect();
        return;
      }
      
      // After configuration, we need to reboot the device
      logDebug("MQTT configured, rebooting device...");
      Shelly.call("Shelly.Reboot", {});
    });
    return;
  }
  
  // Subscribe to MQTT connection events
  MQTT.setConnectHandler(handleMqttConnected);
  
  MQTT.setDisconnectHandler(function() {
    console.log("Disconnected from MQTT broker");
    state.connected = false;
    resetComponents();
    
    // Clear keepalive timer
    if (state.keepaliveTimer) {
      Timer.clear(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
    
    scheduleReconnect();
  });
}

// Send keepalive message
function sendKeepalive(suppressRepublish) {
  if (!state.connected) {
    logDebug("Cannot send keepalive: not connected");
    return;
  }
  
  let keepaliveTopic = "R/" + config.cerbo.portalId + "/keepalive";
  let payload = "";
  
  if (suppressRepublish) {
    payload = JSON.stringify({
      "keepalive-options": ["suppress-republish"]
    });
  }
  
  MQTT.publish(keepaliveTopic, payload, 1, false);
  logDebug("Sent keepalive" + (suppressRepublish ? " (suppress-republish)" : ""));
}

// Schedule reconnection attempt
function scheduleReconnect() {
  if (!state.reconnectTimer) {
    logDebug("Scheduling reconnect in " + (config.cerbo.reconnectDelay / 1000) + " seconds");
    state.reconnectTimer = Timer.set(config.cerbo.reconnectDelay, false, function() {
      state.reconnectTimer = null;
      connectMqtt();
    });
  }
}

// Initialize the script
function initializeVirtualComponents() {
  logDebug("Initializing virtual components");
  
  // Get existing components
  Shelly.call(
    "Shelly.GetComponents",
    {
      keys: [
        "number:" + config.virtualComponents.batterySOC, 
        "boolean:" + config.virtualComponents.acConnected, 
        "group:212"
      ],
      include: ["config"]
    },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting components: " + error_message);
        // Start monitoring anyway
        connectMqtt();
        return;
      }
      
      // Process existing components
      let existingComponentKeys = [];
      if (result && result.components && Array.isArray(result.components)) {
        logDebug("Found " + result.components.length + " existing virtual components");
        for (let i = 0; i < result.components.length; i++) {
          if (result.components[i] && result.components[i].key) {
            existingComponentKeys.push(result.components[i].key);
          }
        }
      } else {
        logDebug("No existing virtual components found or invalid response");
      }
      
      // Create or get components
      setupVirtualComponents(existingComponentKeys);
    }
  );
}

// Start the script
function init() {
  console.log("Starting Cerbo GX Monitor Script");
  initializeVirtualComponents();
}

// Start the script
init();
