// Frequency Monitor and Control Script for Shelly 1PM Gen3
// This script periodically checks the frequency and controls the relay based on configurable thresholds.

// Configuration using virtual components for user-adjustable settings
let highFreqThreshold = 50.5;  // Hz - default value, will be overridden by virtual component
let lowFreqThreshold = 50.4;   // Hz - default value, will be overridden by virtual component
let minOnTime = 10 * 60 * 1000; // 10 minutes in milliseconds - default value, will be overridden
let checkInterval = 60 * 1000;  // 1 minute in milliseconds - default value, will be overridden

// Virtual component handles
let highFreqHandle = null;
let lowFreqHandle = null;
let minTimeHandle = null;
let intervalHandle = null;
let statusHandle = null;
let groupHandle = null;

// State variables
let lastSwitchedOnTime = 0;     // When we last turned the relay on
let scriptControlledOn = false;  // Flag to track if WE turned it on (vs. external control)
let currentFreq = 0;             // Current frequency reading
let relayIsOn = false;           // Current relay state
let inputIsActive = false;       // State of the input
let debugMode = true;            // Enable debug logging
let componentsInitialized = false;
let timerId = null;

// Helper function for logging
function logDebug(message) {
  if (debugMode) {
    console.log("[DEBUG] " + message);
  }
}

// Log configuration values
function logConfiguration() {
  console.log("=== Frequency Controller Configuration ===");
  console.log("High Frequency Threshold: " + highFreqThreshold + " Hz");
  console.log("Low Frequency Threshold: " + lowFreqThreshold + " Hz");
  console.log("Minimum On Time: " + (minOnTime / (60 * 1000)) + " minutes");
  console.log("Check Interval: " + (checkInterval / 1000) + " seconds");
  console.log("=========================================");
}

// Update the status display
function updateStatus(event) {
  let freqPart = currentFreq ? currentFreq.toFixed(2) + "Hz" : "No freq data";
  let thresholdInfo = " [H:" + highFreqThreshold.toFixed(1) + "/L:" + lowFreqThreshold.toFixed(1) + "]";
  let relayPart = relayIsOn ? "Relay ON" : "Relay OFF";
  let controlPart = relayIsOn ? (scriptControlledOn ? " (script)" : " (external)") : "";
  let inputPart = ", Input " + (inputIsActive ? "ON" : "OFF");
  let eventPart = event ? " - " + event : "";
  
  let statusMessage = freqPart + thresholdInfo + ", " + relayPart + controlPart + inputPart + eventPart;
  logDebug("Status update: " + statusMessage);
  
  // Update status virtual component if available
  if (statusHandle && componentsInitialized) {
    try {
      statusHandle.setValue(statusMessage);
    } catch (e) {
      console.log("Error updating status component: " + e.message);
    }
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

// Create or get all virtual components sequentially
function setupVirtualComponents(existingComponentKeys) {
  // Step 1: Create or get high frequency component
  if (!arrayContains(existingComponentKeys, "number:200")) {
    console.log("Creating high frequency threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: 200,
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
    try {
      highFreqHandle = Virtual.getHandle("number:200");
      if (highFreqHandle && highFreqHandle.getValue() !== undefined) {
        highFreqThreshold = parseFloat(highFreqHandle.getValue());
        logDebug("Loaded high frequency threshold: " + highFreqThreshold);
      }
    } catch (e) {
      console.log("Error getting high frequency handle: " + e.message);
    }
  }
  
  // Step 2: Create or get low frequency component
  if (!arrayContains(existingComponentKeys, "number:201")) {
    console.log("Creating low frequency threshold component");
    Shelly.call("Virtual.Add", {
      type: "number",
      id: 201,
      config: {
        name: "Low Frequency Threshold",
        default_value: lowFreqThreshold,
        min: 49.0,
        max: 52.0,
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
    try {
      lowFreqHandle = Virtual.getHandle("number:201");
      if (lowFreqHandle && lowFreqHandle.getValue() !== undefined) {
        lowFreqThreshold = parseFloat(lowFreqHandle.getValue());
        logDebug("Loaded low frequency threshold: " + lowFreqThreshold);
      }
    } catch (e) {
      console.log("Error getting low frequency handle: " + e.message);
    }
  }
  
  // Step 3: Create or get status component 
  if (!arrayContains(existingComponentKeys, "text:204")) {
    console.log("Creating status component");
    Shelly.call("Virtual.Add", {
      type: "text",
      id: 204,
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
    try {
      statusHandle = Virtual.getHandle("text:204");
    } catch (e) {
      console.log("Error getting status handle: " + e.message);
    }
  }
  
  // Step 4: Create or get group component to make all components visible in the UI
  if (!arrayContains(existingComponentKeys, "group:205")) {
    console.log("Creating group component");
    Shelly.call("Virtual.Add", {
      type: "group",
      id: 205,
      config: {
        name: "Frequency Controller",
        components: ["number:200", "number:201", "text:204"]
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
    highFreqHandle = Virtual.getHandle("number:200");
    lowFreqHandle = Virtual.getHandle("number:201");
    statusHandle = Virtual.getHandle("text:204");
    
    // Get values from components
    if (highFreqHandle && highFreqHandle.getValue() !== undefined) {
      highFreqThreshold = parseFloat(highFreqHandle.getValue());
    }
    
    if (lowFreqHandle && lowFreqHandle.getValue() !== undefined) {
      lowFreqThreshold = parseFloat(lowFreqHandle.getValue());
    }
    
    componentsInitialized = true;
    
    // Set up event handlers
    setupEventHandlers();
    
    // Start monitoring
    startFrequencyMonitoring();
    
    // Log configuration
    logConfiguration();
    updateStatus("Monitoring started");
  } catch (e) {
    console.log("Error in finishSetup: " + e.message);
    // Start monitoring even if there's an error with the components
    startFrequencyMonitoring();
  }
}

// Add event handlers for virtual components
function setupEventHandlers() {
  logDebug("Setting up event handlers");
  
  // High frequency threshold
  if (highFreqHandle) {
    try {
      highFreqHandle.on("change", function(ev_info) {
        highFreqThreshold = parseFloat(ev_info.value || highFreqThreshold);
        updateStatus("High threshold updated to " + highFreqThreshold);
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
        updateStatus("Low threshold updated to " + lowFreqThreshold);
      });
    } catch (e) {
      console.log("Error setting up low threshold handler: " + e.message);
    }
  }
  
  // Watch for switch events
  Shelly.addEventHandler(function(event) {
    if (event.name === "switch" && event.info.event === "toggle") {
      logDebug("Switch toggle event detected");
      updateRelayState();
    }
    
    if (event.name === "input" && event.info.startsWith("toggle")) {
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
      keys: ["number:200", "number:201", "text:204", "group:205"],
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
function turnRelayOn() {
  logDebug("Attempting to turn relay ON");
  
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
      updateStatus("Frequency high - activating relay");
    }
  );
}

// Turn the relay off if we previously turned it on
function turnRelayOff() {
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
  
  logDebug("Attempting to turn relay OFF");
  
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
      updateStatus("Frequency normal - deactivating relay");
    }
  );
}

// Check the grid frequency and control the relay accordingly
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
      const currentTime = Date.now();
      const timeElapsed = currentTime - lastSwitchedOnTime;
      
      logDebug("Current frequency: " + currentFreq + "Hz, Relay: " + (relayIsOn ? "ON" : "OFF") + 
               ", Time elapsed: " + Math.floor(timeElapsed/1000) + "s");
      
      // Also update input state
      updateInputState();
      
      // Update status
      updateStatus("Monitoring");

      // Check against thresholds
      if (currentFreq >= highFreqThreshold && !relayIsOn) {
        // Frequency is high and relay is off - turn it on
        logDebug("High frequency detected: " + currentFreq + "Hz >= " + highFreqThreshold + "Hz");
        turnRelayOn();
        return;
      }
      
      if (currentFreq <= lowFreqThreshold && relayIsOn && scriptControlledOn && timeElapsed >= minOnTime) {
        // Frequency is low, relay is on, script controlled it, and minimum time has elapsed
        logDebug("Low frequency detected: " + currentFreq + "Hz <= " + lowFreqThreshold + "Hz, " +
                 "Time elapsed: " + Math.floor(timeElapsed/1000) + "s >= Min time: " + Math.floor(minOnTime/1000) + "s");
        turnRelayOff();
        return;
      }
    }
  );
}

// Start the frequency monitoring
function startFrequencyMonitoring() {
  logDebug("Starting frequency monitoring with interval: " + (checkInterval/1000) + " seconds");
  
  // Clear existing timer if it exists
  if (timerId !== null) {
    Timer.clear(timerId);
    logDebug("Cleared existing timer");
  }
  
  // Start new timer with current interval
  timerId = Timer.set(checkInterval, true, function() {
    logDebug("Timer triggered frequency check");
    checkFrequency();
  });
  
  // Initial check immediately
  checkFrequency();
}

// Initialize the script
function init() {
  console.log("Frequency Controller Script starting");
  
  // Initial relay and input state update
  updateRelayState();
  updateInputState();
  
  // Set up virtual components
  initializeVirtualComponents();
}

// Run initialization
init();
