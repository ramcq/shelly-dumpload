// Frequency and SOC Monitor and Control Script for Shelly 1PM Gen3
// This script controls the relay based on grid frequency and battery SOC from Victron Cerbo GX

// ===== Configuration =====
// Frequency thresholds
let highFreqThreshold = 50.5;  // Hz - default value, will be overridden by virtual component
let lowFreqThreshold = 50.4;   // Hz - default value, will be overridden by virtual component

// SOC thresholds - defaults, will be made configurable with virtual components
let highSocThreshold = 95;     // % - enable relay when SOC exceeds this value
let lowSocThreshold = 94;      // % - disable relay when SOC falls below this value

// Timing settings
let minOnTime = 10 * 60 * 1000; // 10 minutes in milliseconds
let checkInterval = 30 * 1000;  // 30 seconds in milliseconds
let requiredHighReadings = 2;   // Number of consecutive high frequency readings required before triggering

// ===== Virtual component IDs =====
// Frequency control components (200-205)
const VCOMP_HIGH_FREQ = 200;
const VCOMP_LOW_FREQ = 201;

// SOC control components (202-203)
const VCOMP_HIGH_SOC = 202;
const VCOMP_LOW_SOC = 203;

// Status
const VCOMP_STATUS = 204;
const VCOMP_GROUP = 205;

// Victron MQTT components (from victron-mqtt.js)
const VCOMP_BATTERY_SOC = 210; // Reported SOC from Victron
const VCOMP_AC_CONNECTED = 211; // AC input status from Victron

// ===== Virtual component handles =====
// Frequency threshold components
let highFreqHandle = null;
let lowFreqHandle = null;
let statusHandle = null;

// SOC threshold components
let highSocHandle = null;
let lowSocHandle = null;

// Victron data components
let batterySocHandle = null;  // SOC from Victron
let acConnectedHandle = null; // AC input status from Victron

// ===== State variables =====
let lastSwitchedOnTime = 0;      // When we last turned the relay on
let scriptControlledOn = false;  // Flag to track if WE turned it on (vs. external control)
let currentFreq = 0;             // Current frequency reading
let currentSoc = 0;              // Current SOC from victron-mqtt script
let acInputConnected = false;    // Current AC input status from victron-mqtt script
let relayIsOn = false;           // Current relay state
let inputIsActive = false;       // State of the input
let debugMode = true;            // Enable debug logging
let consecutiveHighReadings = 0; // Count of consecutive readings above high threshold
let timerId = null;

// ===== Helper functions =====
// Helper function for logging
function logDebug(message) {
  if (debugMode) {
    console.log("[DEBUG] " + message);
  }
}

// Log configuration values
function logConfiguration() {
  console.log("=== Frequency & SOC Controller Configuration ===");
  console.log("High Frequency Threshold: " + highFreqThreshold + " Hz");
  console.log("Low Frequency Threshold: " + lowFreqThreshold + " Hz");
  console.log("High SOC Threshold: " + highSocThreshold + "%");
  console.log("Low SOC Threshold: " + lowSocThreshold + "%");
  console.log("Minimum On Time: " + (minOnTime / (60 * 1000)) + " minutes");
  console.log("Check Interval: " + (checkInterval / 1000) + " seconds");
  console.log("Required High Frequency Readings: " + requiredHighReadings);
  console.log("============================================");
}

// Update the status display
function updateStatus(event) {
  // Format different sections of the status message
  let freqPart = currentFreq ? currentFreq.toFixed(2) + "Hz" : "No freq data";
  let freqThresholdInfo = " [H:" + highFreqThreshold.toFixed(1) + "/L:" + lowFreqThreshold.toFixed(1) + "]";
  
  let socPart = currentSoc > 0 ? currentSoc + "%" : "No SOC data";
  let socThresholdInfo = " [H:" + highSocThreshold + "/L:" + lowSocThreshold + "]";
  
  let relayPart = relayIsOn ? "Relay ON" : "Relay OFF";
  let controlPart = relayIsOn ? (scriptControlledOn ? " (script)" : " (external)") : "";
  
  let inputPart = ", Input " + (inputIsActive ? "ON" : "OFF");
  let acPart = ", AC-In " + (acInputConnected ? "ON" : "OFF");
  
  let countPart = consecutiveHighReadings > 0 ? " (High count: " + consecutiveHighReadings + ")" : "";
  let eventPart = event ? ": " + event : "";
  
  // Combine status sections
  let statusMessage = freqPart + freqThresholdInfo + ", " + 
                      socPart + socThresholdInfo + ", " + 
                      relayPart + controlPart + 
                      inputPart + acPart + 
                      countPart + eventPart;
  
  logDebug("Status update: " + statusMessage);
  
  // Update status virtual component if available
  if (!statusHandle)
    return;
    
  try {
    statusHandle.setValue(statusMessage);
  } catch (e) {
    console.log("Error updating status component: " + e.message);
  }
}

// Helper function to check if an array contains a value
function arrayContains(array, value) {
  for (let i = 0; i < array.length; i++) {
    if (array[i] === value) {
      return true;
    }
  }
  return false;
}

// ===== Virtual component setup =====
// Create or get all virtual components sequentially
function setupVirtualComponents(existingComponentKeys) {
  // Step 1: Create or get high frequency component
  if (!arrayContains(existingComponentKeys, "number:" + VCOMP_HIGH_FREQ)) {
    console.log("Creating high frequency threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: VCOMP_HIGH_FREQ,
      config: {
        name: "High Frequency Threshold",
        default_value: highFreqThreshold,
        min: 50.0,
        max: 53.0,
        meta: {
          ui: {
            view: "slider",
            unit: "Hz",
            step: 0.05
          }
        },
        persisted: true
      }
    });
  } else {
    logDebug("High frequency component already exists");
  }
  
  // Step 2: Create or get low frequency component
  if (!arrayContains(existingComponentKeys, "number:" + VCOMP_LOW_FREQ)) {
    console.log("Creating low frequency threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: VCOMP_LOW_FREQ,
      config: {
        name: "Low Frequency Threshold",
        default_value: lowFreqThreshold,
        min: 50.0,
        max: 53.0,
        meta: {
          ui: {
            view: "slider",
            unit: "Hz",
            step: 0.05
          }
        },
        persisted: true
      }
    });
  } else {
    logDebug("Low frequency component already exists");
  }
  
  // Step 3: Create or get high SOC threshold component
  if (!arrayContains(existingComponentKeys, "number:" + VCOMP_HIGH_SOC)) {
    console.log("Creating high SOC threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: VCOMP_HIGH_SOC,
      config: {
        name: "High SOC Threshold",
        default_value: highSocThreshold,
        min: 50,
        max: 100,
        meta: {
          ui: {
            view: "slider",
            unit: "%",
            step: 1
          }
        },
        persisted: true
      }
    });
  } else {
    logDebug("High SOC component already exists");
  }
  
  // Step 4: Create or get low SOC threshold component
  if (!arrayContains(existingComponentKeys, "number:" + VCOMP_LOW_SOC)) {
    console.log("Creating low SOC threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: VCOMP_LOW_SOC,
      config: {
        name: "Low SOC Threshold",
        default_value: lowSocThreshold,
        min: 49,
        max: 99,
        meta: {
          ui: {
            view: "slider",
            unit: "%",
            step: 1
          }
        },
        persisted: true
      }
    });
  } else {
    logDebug("Low SOC component already exists");
  }
  
  // Step 5: Create or get status component 
  if (!arrayContains(existingComponentKeys, "text:" + VCOMP_STATUS)) {
    console.log("Creating status component");
    Shelly.call("Virtual.Add", {
      type: "text",
      id: VCOMP_STATUS,
      config: {
        name: "Status",
        default_value: "",
        meta: {
          ui: {
            view: "label"
          }
        }
      }
    });
  } else {
    logDebug("Status component already exists");
  }
  
  // Step 6: Create or get group component to make all components visible in the UI
  if (!arrayContains(existingComponentKeys, "group:" + VCOMP_GROUP)) {
    console.log("Creating group component");
    Shelly.call("Virtual.Add", {
      type: "group",
      id: VCOMP_GROUP,
      config: {
        name: "Smart Load Controller",
        components: [
          "number:" + VCOMP_HIGH_FREQ, 
          "number:" + VCOMP_LOW_FREQ,
          "number:" + VCOMP_HIGH_SOC,
          "number:" + VCOMP_LOW_SOC,
          "text:" + VCOMP_STATUS
        ]
      }
    });
  } else {
    logDebug("Updating group component to include SOC thresholds");
    // Make sure the group includes the SOC components
    Shelly.call("Group.Set", {
      id: VCOMP_GROUP,
      value: [
        "number:" + VCOMP_HIGH_FREQ, 
        "number:" + VCOMP_LOW_FREQ,
        "number:" + VCOMP_HIGH_SOC,
        "number:" + VCOMP_LOW_SOC,
        "text:" + VCOMP_STATUS
      ]
    }, function(result, error_code, error_message) {
      if (error_code !== 0) {
        logDebug("Failed to update group config: " + error_message);
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
  
  // Try to get handles for our configuration components
  try {
    highFreqHandle = Virtual.getHandle("number:" + VCOMP_HIGH_FREQ);
    lowFreqHandle = Virtual.getHandle("number:" + VCOMP_LOW_FREQ);
    highSocHandle = Virtual.getHandle("number:" + VCOMP_HIGH_SOC);
    lowSocHandle = Virtual.getHandle("number:" + VCOMP_LOW_SOC);
    statusHandle = Virtual.getHandle("text:" + VCOMP_STATUS);
    
    // Get values from components
    if (highFreqHandle && highFreqHandle.getValue() !== undefined) {
      highFreqThreshold = parseFloat(highFreqHandle.getValue());
      logDebug("Loaded high frequency threshold: " + highFreqThreshold);
    }
    
    if (lowFreqHandle && lowFreqHandle.getValue() !== undefined) {
      lowFreqThreshold = parseFloat(lowFreqHandle.getValue());
      logDebug("Loaded low frequency threshold: " + lowFreqThreshold);
    }
    
    if (highSocHandle && highSocHandle.getValue() !== undefined) {
      highSocThreshold = parseFloat(highSocHandle.getValue());
      logDebug("Loaded high SOC threshold: " + highSocThreshold);
    }
    
    if (lowSocHandle && lowSocHandle.getValue() !== undefined) {
      lowSocThreshold = parseFloat(lowSocHandle.getValue());
      logDebug("Loaded low SOC threshold: " + lowSocThreshold);
    }
  } catch (e) {
    console.log("Error getting component handles: " + e.message);
  }
  
  // Try to get handles for Victron data components
  try {
    batterySocHandle = Virtual.getHandle("number:" + VCOMP_BATTERY_SOC);
    acConnectedHandle = Virtual.getHandle("boolean:" + VCOMP_AC_CONNECTED);
    
    // Get initial values if available
    if (batterySocHandle && batterySocHandle.getValue() !== undefined) {
      currentSoc = parseFloat(batterySocHandle.getValue());
      logDebug("Initial SOC value: " + currentSoc);
    }
    
    if (acConnectedHandle && acConnectedHandle.getValue() !== undefined) {
      acInputConnected = Boolean(acConnectedHandle.getValue());
      logDebug("Initial AC connected value: " + acInputConnected);
    }
  } catch (e) {
    console.log("Error getting Victron component handles: " + e.message);
    console.log("(This is normal if victron-mqtt.js is not running)");
  }
  
  // Set up event handlers
  setupEventHandlers();
  
  // Start monitoring
  startFrequencyMonitoring();
  
  // Log configuration
  logConfiguration();
  updateStatus("Monitoring started");
}

// Add event handlers for virtual components
function setupEventHandlers() {
  logDebug("Setting up event handlers");
  
  // High frequency threshold
  if (highFreqHandle) {
    try {
      highFreqHandle.on("change", function(ev_info) {
        highFreqThreshold = parseFloat(ev_info.value || highFreqThreshold);
        // Reset consecutive counter when threshold changes
        consecutiveHighReadings = 0;
        updateStatus("High frequency threshold updated to " + highFreqThreshold);
      });
    } catch (e) {
      console.log("Error setting up high threshold handler: " + e.message);
    }
  }
  
  // Low frequency threshold
  if (lowFreqHandle) {
    try {
      lowFreqHandle.on("change", function(ev_info) {
        lowFreqThreshold = parseFloat(ev_info.value || lowFreqThreshold);
        updateStatus("Low frequency threshold updated to " + lowFreqThreshold);
      });
    } catch (e) {
      console.log("Error setting up low threshold handler: " + e.message);
    }
  }
  
  // High SOC threshold
  if (highSocHandle) {
    try {
      highSocHandle.on("change", function(ev_info) {
        highSocThreshold = parseFloat(ev_info.value || highSocThreshold);
        updateStatus("High SOC threshold updated to " + highSocThreshold);
      });
    } catch (e) {
      console.log("Error setting up high SOC handler: " + e.message);
    }
  }
  
  // Low SOC threshold
  if (lowSocHandle) {
    try {
      lowSocHandle.on("change", function(ev_info) {
        lowSocThreshold = parseFloat(ev_info.value || lowSocThreshold);
        updateStatus("Low SOC threshold updated to " + lowSocThreshold);
      });
    } catch (e) {
      console.log("Error setting up low SOC handler: " + e.message);
    }
  }
  
  // Watch for switch events
  Shelly.addEventHandler(function(event) {
    logDebug("Event received: " + JSON.stringify(event));
    
    // Make sure event has the necessary properties before checking them
    if (!event || !event.name || !event.info || !event.info.event)
      return;

    if (event.name === "switch" && event.info.event === "toggle") {
      logDebug("Switch toggle event detected");
      updateRelayState();
    }
    
    if (event.name === "input" && event.info.event.indexOf("toggle") === 0) {
      logDebug("Input toggle event detected");
      updateInputState();
    }
  });
}

// Initialize virtual components
function initializeVirtualComponents() {
  logDebug("Initializing virtual components");
  
  // Get existing components
  Shelly.call(
    "Shelly.GetComponents",
    {
      keys: [
        "number:" + VCOMP_HIGH_FREQ, 
        "number:" + VCOMP_LOW_FREQ,
        "number:" + VCOMP_HIGH_SOC,
        "number:" + VCOMP_LOW_SOC,
        "text:" + VCOMP_STATUS, 
        "group:" + VCOMP_GROUP
      ],
      include: ["config"]
    },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting components: " + error_message);
        // Start monitoring anyway
        startFrequencyMonitoring();
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

// ===== Device state management =====
// Get current relay state and update our tracking
function updateRelayState() {
  Shelly.call(
    "Switch.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting switch status: " + error_message);
        return;
      }
      
      if (!result || result.output === undefined) {
        console.log("Invalid switch status response");
        return;
      }
      
      if (relayIsOn === result.output)
        return;
      
      // Update relay state
      relayIsOn = result.output;
      
      // If relay is off, we're definitely not controlling it
      if (!relayIsOn) {
        scriptControlledOn = false;
      }
      
      updateStatus("Relay state updated");
    }
  );
}

// Get current input state
function updateInputState() {
  Shelly.call(
    "Input.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting input status: " + error_message);
        return;
      }
      
      if (!result || result.state === undefined) {
        console.log("Invalid input status response");
        return;
      }
      
      if (inputIsActive === result.state)
        return;
      
      // Update input state
      inputIsActive = result.state;
      
      updateStatus("Input state updated");
    }
  );
}

// Turn the relay on
function turnRelayOn(reason) {
  logDebug("Attempting to turn relay ON: " + reason);
  
  Shelly.call(
    "Switch.Set",
    { id: 0, on: true },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay on: " + error_message);
        return;
      }
      
      scriptControlledOn = true;
      relayIsOn = true;
      lastSwitchedOnTime = Date.now();
      updateStatus(reason);
      
      // Reset high readings counter after action taken
      consecutiveHighReadings = 0;
    }
  );
}

// Turn the relay off if we previously turned it on
function turnRelayOff(reason) {
  // Only turn off if we previously turned it on
  if (!scriptControlledOn) {
    logDebug("Not turning relay off - not under script control");
    return;
  }
  
  // Don't turn off if the input is active
  if (inputIsActive) {
    logDebug("Not turning relay off - input is active");
    scriptControlledOn = false;  // Clear our control flag
    updateStatus("Input active - relinquishing control");
    return;
  }
  
  logDebug("Attempting to turn relay OFF: " + reason);
  
  Shelly.call(
    "Switch.Set",
    { id: 0, on: false },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error turning relay off: " + error_message);
        return;
      }
      
      scriptControlledOn = false;
      relayIsOn = false;
      updateStatus(reason);
    }
  );
}

// Check the current system state and control the relay accordingly
function checkSystemState() {
  if (batterySocHandle && batterySocHandle.getValue() !== undefined) {
    currentSoc = parseFloat(batterySocHandle.getValue());
  }
  
  if (acConnectedHandle && acConnectedHandle.getValue() !== undefined) {
    acInputConnected = Boolean(acConnectedHandle.getValue());
  }
  
  updateStatus("Monitoring");
  
  // If AC input is connected, we should avoid enabling the relay
  if (acInputConnected) {
    if (relayIsOn && scriptControlledOn) {
      turnRelayOff("AC input connected");
    } else {
      logDebug("AC input connected - no control action will be taken");
    }
    
    return;
  }
  
  const currentTime = Date.now();
  const timeElapsed = currentTime - lastSwitchedOnTime;
  
  // SOC control mode
  if (currentSoc > 0) {
    logDebug("SOC control mode: Current SOC=" + currentSoc + "%, High threshold=" + 
             highSocThreshold + "%, Low threshold=" + lowSocThreshold + "%");
    
    // Enable when SOC is high enough
    if (currentSoc >= highSocThreshold && !relayIsOn) {
      turnRelayOn("SOC reached high threshold: " + currentSoc + "% >= " + highSocThreshold + "%");
    }
    // Disable when SOC is low enough and minimum on time has elapsed
    else if (currentSoc <= lowSocThreshold && relayIsOn && scriptControlledOn && timeElapsed >= minOnTime) {
      turnRelayOff("SOC reached low threshold: " + currentSoc + "% <= " + lowSocThreshold + "%");
    }
  }
  // Frequency control mode
  else {
    logDebug("Frequency control mode: Current freq=" + currentFreq + "Hz, High threshold=" + 
             highFreqThreshold + "Hz, Low threshold=" + lowFreqThreshold + "Hz");
    
    if (currentFreq >= highFreqThreshold) {
      consecutiveHighReadings++;
      logDebug("High frequency detected: " + currentFreq + "Hz >= " + highFreqThreshold + 
              "Hz, Consecutive readings: " + consecutiveHighReadings + "/" + requiredHighReadings);
      
      // Enable when frequency has been high for required consecutive readings
      if (consecutiveHighReadings >= requiredHighReadings && !relayIsOn) {
        turnRelayOn("Frequency high for " + consecutiveHighReadings + "/" + requiredHighReadings + " readings");
      }
    } else {
      // Reset counter if frequency drops below threshold
      consecutiveHighReadings = 0;
      
      // Disable when frequency is low and minimum on time has elapsed
      if (currentFreq <= lowFreqThreshold && relayIsOn && scriptControlledOn && timeElapsed >= minOnTime) {
        turnRelayOff("Frequency low: " + currentFreq + "Hz <= " + lowFreqThreshold + "Hz");
      }
    }
  }
}

// Check the grid frequency and update state
function checkFrequency() {
  Shelly.call(
    "Switch.GetStatus",
    { id: 0 },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        console.log("Error getting switch status: " + error_message);
        return;
      }
      
      if (!result) {
        console.log("Invalid switch status result");
        return;
      }
      
      if (result.freq === undefined) {
        logDebug("No frequency data available in switch status");
        return;
      }
      
      currentFreq = result.freq;
      relayIsOn = result.output;
      
      // Also update input state
      updateInputState();
      
      // Check if action needed
      checkSystemState();
    }
  );
}

// Start the frequency monitoring
function startFrequencyMonitoring() {
  logDebug("Starting monitoring with interval: " + (checkInterval/1000) + " seconds");
  
  // Clear existing timer if it exists
  if (timerId !== null) {
    Timer.clear(timerId);
    logDebug("Cleared existing timer");
  }
  
  // Start new timer with current interval
  timerId = Timer.set(checkInterval, true, function() {
    logDebug("Timer triggered check");
    checkFrequency();
  });
  
  // Initial check immediately
  checkFrequency();
}

// Initialize the script
function init() {
  console.log("Smart Load Controller Script starting");
  
  // Initial relay and input state update
  updateRelayState();
  updateInputState();
  
  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
