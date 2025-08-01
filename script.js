// Polar Data Collector - Enhanced JavaScript Implementation
document.addEventListener('DOMContentLoaded', () => {
    // --- Constants ---
    const BATCH_SIZE = 1000; // Flush to DB every 1000 data points
    const DATA_QUALITY_CHECK_INTERVAL = 5000; // 5 seconds
    const MAX_RECONNECT_ATTEMPTS = 3;
    const DB_NAME = 'polar-data-collector';
    const STORE_NAME = 'sessions';
    
    // A simple helper function to create a delay
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Bluetooth UUIDs
    const HR_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
    const HR_CHARACTERISTIC_UUID = '00002a37-0000-1000-8000-00805f9b34fb';
    const PMD_SERVICE_UUID = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
    const PMD_CONTROL_UUID = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
    const PMD_DATA_UUID = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
    const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
    const BATTERY_LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

    // Sample rates
    const SAMPLE_RATES = {
        ECG: [130, 125, 200, 250, 500],
        ACC: [25, 50, 100, 200]
    };

    // --- UI Elements ---
    const elements = {
        participantIdInput: document.getElementById('participant-id'),
        connectButton: document.getElementById('btn-connect'),
        disconnectButton: document.getElementById('btn-disconnect'),
        recordButton: document.getElementById('btn-record'),
        recordText: document.getElementById('record-text'),
        recordTimer: document.getElementById('record-timer'),
        exportCsvButton: document.getElementById('btn-export-csv'),
        exportJsonButton: document.getElementById('btn-export-json'),
        clearButton: document.getElementById('btn-clear'),
        addEventButton: document.getElementById('btn-add-event'),
        eventLabelInput: document.getElementById('event-label-input'),
        hrValue: document.getElementById('hr-value'),
        rrValue: document.getElementById('rr-value'),
        ecgValue: document.getElementById('ecg-value'),
        accValue: document.getElementById('acc-value'),
        eventLog: document.getElementById('event-log'),
        statusDot: document.getElementById('status-dot'),
        statusText: document.getElementById('status-text'),
        modal: document.getElementById('modal'),
        modalTitle: document.getElementById('modal-title'),
        modalMessage: document.getElementById('modal-message'),
        modalButtons: document.getElementById('modal-buttons'),
        streamHrCheckbox: document.getElementById('stream-hr'),
        streamEcgCheckbox: document.getElementById('stream-ecg'),
        streamAccCheckbox: document.getElementById('stream-acc'),
        ecgSampleRate: document.getElementById('ecg-sample-rate'),
        accSampleRate: document.getElementById('acc-sample-rate'),
        sampleRateControls: document.getElementById('sample-rate-controls'),
        ecgRateControl: document.getElementById('ecg-rate-control'),
        accRateControl: document.getElementById('acc-rate-control'),
        batteryIndicator: document.getElementById('battery-indicator'),
        batteryPercent: document.getElementById('battery-percent'),
        batteryIcon: document.getElementById('battery-icon'),
        storageIndicator: document.getElementById('storage-indicator'),
        storagePercent: document.getElementById('storage-percent'),
        dataQuality: document.getElementById('data-quality'),
        qualityStatus: document.getElementById('quality-status'),
        gapCount: document.getElementById('gap-count'),
        recordingStats: document.getElementById('recording-stats'),
        hrCount: document.getElementById('hr-count'),
        rrCount: document.getElementById('rr-count'),
        ecgCount: document.getElementById('ecg-count'),
        accCount: document.getElementById('acc-count'),
        hrIndicator: document.getElementById('hr-indicator'),
        rrIndicator: document.getElementById('rr-indicator'),
        ecgIndicator: document.getElementById('ecg-indicator'),
        accIndicator: document.getElementById('acc-indicator')
    };

    // --- App State ---
    let db;
    let bluetoothDevice = null;
    let gattServer = null;
    let isRecording = false;
    let currentSession = null;
    let sessionBuffer = {
        hrData: [],
        rrData: [],
        ecgData: [],
        accData: [],
        events: []
    };
    let reconnectAttempts = 0;
    let recordingStartTime = null;
    let recordingInterval = null;
    let lastDataTimestamp = Date.now();
    let dataGaps = 0;
    let dataCounts = { hr: 0, rr: 0, ecg: 0, acc: 0 };
    let dataQualityInterval = null;
    let autoFlushInterval = null;

    // --- Database Functions ---
    async function initDB() {
        try {
            db = await idb.openDB(DB_NAME, 2, {
                upgrade(db, oldVersion) {
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    }
                }
            });
            console.log('Database initialized');
            await checkStorageQuota();
            await checkForExistingData();
        } catch (error) {
            console.error('Failed to initialize database:', error);
            db = null; // Ensure db is explicitly set to null on failure
            showModal('Database Error', 'Failed to initialize local storage. Recording will still work but data will not be saved permanently.');
        }
    }

    async function checkStorageQuota() {
        if (!db || typeof db.transaction !== 'function') return; // Skip if database is not available
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            try {
                const { usage, quota } = await navigator.storage.estimate();
                const percentUsed = Math.round((usage / quota) * 100);
                
                elements.storagePercent.textContent = `${percentUsed}%`;
                elements.storageIndicator.classList.remove('hidden');
                
                if (percentUsed > 90) {
                    elements.storageIndicator.classList.add('critical');
                    showModal('Storage Warning', `Storage is ${percentUsed}% full. Please export and clear old data.`);
                } else if (percentUsed > 75) {
                    elements.storageIndicator.classList.add('warning');
                }
            } catch (error) {
                console.error('Failed to check storage quota:', error);
            }
        }
    }

    async function checkForExistingData() {
        if (!db || typeof db.getAll !== 'function') return; // Skip if database is not available
        const sessions = await getAllSessions();
        if (sessions.length > 0) {
            elements.exportCsvButton.disabled = false;
            elements.exportJsonButton.disabled = false;
            elements.clearButton.disabled = false;
            
            // Check for incomplete sessions
            const incomplete = sessions.find(s => !s.endTime);
            if (incomplete) {
                showModal('Resume Session?', 
                    `Found incomplete session for ${incomplete.participantId}. Would you like to resume?`,
                    true, () => resumeSession(incomplete));
            } else {
                showModal('Existing Data Found', 
                    `You have ${sessions.length} previous session(s) stored.`);
            }
        }
    }

    async function saveSession(session) {
        if (!db || typeof db.put !== 'function') return;
        try {
            await db.put(STORE_NAME, session);
        } catch (error) {
            console.error('Failed to save session:', error);
            showModal('Save Error', 'Failed to save data. Please check storage space.');
        }
    }

    async function flushBufferToDatabase() {
        if (!currentSession || !db || typeof db.get !== 'function') return;
        
        try {
            // Double-check db is still valid before using it
            if (!db || typeof db.get !== 'function') {
                console.warn('Database became unavailable during flush operation');
                return;
            }
            
            let existingSession = currentSession;
            try {
                existingSession = await db.get(STORE_NAME, currentSession.id) || currentSession;
            } catch (dbError) {
                console.warn('Failed to get existing session from database:', dbError);
                existingSession = currentSession;
            }
            
            // Merge buffered data with existing data
            let hasNewData = false;
            Object.keys(sessionBuffer).forEach(key => {
                if (sessionBuffer[key].length > 0) {
                    existingSession[key] = [...(existingSession[key] || []), ...sessionBuffer[key]];
                    console.log(`Flushing ${sessionBuffer[key].length} ${key} entries to database`);
                    hasNewData = true;
                    sessionBuffer[key] = []; // Clear buffer
                }
            });
            
            if (hasNewData) {
                await saveSession(existingSession);
                console.log('Buffer flushed to database');
            }
        } catch (error) {
            console.error('Failed to flush buffer:', error);
        }
    }

    async function addDataPoint(dataType, data) {
        if (!isRecording || !currentSession) return;
        
        sessionBuffer[dataType].push(data);
        dataCounts[dataType.replace('Data', '')]++;
        
        // Update UI counts
        updateRecordingStats();
        
        // Flush if buffer is full
        if (sessionBuffer[dataType].length >= BATCH_SIZE) {
            await flushBufferToDatabase();
        }
    }

    async function getAllSessions() {
        if (!db || typeof db.getAll !== 'function') return [];
        try {
            return await db.getAll(STORE_NAME);
        } catch (error) {
            console.error('Failed to retrieve sessions:', error);
            return [];
        }
    }

    async function clearAllData() {
        if (!db || typeof db.transaction !== 'function') return;
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            await tx.store.clear();
            await tx.done;
            console.log('All data cleared');
            await checkStorageQuota();
        } catch (error) {
            console.error('Failed to clear data:', error);
            showModal('Clear Error', 'Failed to clear data. Please try again.');
        }
    }

    // --- Bluetooth Connection Functions ---
    function updateStatus(state, message) {
        elements.statusDot.className = `status-dot ${state}`;
        elements.statusText.textContent = message;
    }

    async function connectToDevice() {
        if (!navigator.bluetooth) {
            showModal('Bluetooth Not Available', 
                'Web Bluetooth API is not available. Please use Chrome or Edge browser.');
            return;
        }
        
        try {
            updateStatus('connecting', 'Requesting device...');
            
            // Check selected streams
            const services = [];
            if (elements.streamHrCheckbox.checked) services.push(HR_SERVICE_UUID);
            if (elements.streamEcgCheckbox.checked || elements.streamAccCheckbox.checked) {
                services.push(PMD_SERVICE_UUID);
            }

            if (services.length === 0) {
                showModal('Selection Required', 'Please select at least one data stream.');
                updateStatus('disconnected', 'Disconnected');
                return;
            }

            // Show sample rate controls if needed
            updateSampleRateControls();

            bluetoothDevice = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'Polar' }],
                optionalServices: [HR_SERVICE_UUID, PMD_SERVICE_UUID, BATTERY_SERVICE_UUID]
            });

            bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
            
            updateStatus('connecting', 'Connecting to GATT server...');
            gattServer = await bluetoothDevice.gatt.connect();
            
            // Setup selected data streams
            await setupDataStreams();
            
            // Setup battery monitoring
            await setupBatteryMonitoring();
            
            updateStatus('connected', `Connected to ${bluetoothDevice.name}`);
            onConnected();
            
        } catch (error) {
            console.error('Connection failed:', error);
            showModal('Connection Error', `Failed to connect: ${error.message}`);
            updateStatus('disconnected', 'Disconnected');
            onDisconnected();
        }
    }

    async function setupDataStreams() {
        // Setup HR stream
        if (elements.streamHrCheckbox.checked) {
            try {
                updateStatus('connecting', 'Setting up HR stream...');
                const hrService = await gattServer.getPrimaryService(HR_SERVICE_UUID);
                const hrCharacteristic = await hrService.getCharacteristic(HR_CHARACTERISTIC_UUID);
                hrCharacteristic.addEventListener('characteristicvaluechanged', handleHRMeasurement);
                await hrCharacteristic.startNotifications();
                console.log('HR notifications started');
            } catch (error) {
                console.error('Failed to setup HR stream:', error);
                throw new Error('Failed to setup heart rate monitoring');
            }
        }

        // Setup PMD streams (ECG/ACC)
        if (elements.streamEcgCheckbox.checked || elements.streamAccCheckbox.checked) {
            try {
                updateStatus('connecting', 'Setting up PMD streams...');
                const pmdService = await gattServer.getPrimaryService(PMD_SERVICE_UUID);
                const pmdControl = await pmdService.getCharacteristic(PMD_CONTROL_UUID);
                const pmdData = await pmdService.getCharacteristic(PMD_DATA_UUID);
                
                pmdData.addEventListener('characteristicvaluechanged', handlePMDMeasurement);
                await pmdData.startNotifications();

                // 100ms pause to assist with timing
                await sleep(100); 
                
                // Start ECG stream
                if (elements.streamEcgCheckbox.checked) {
                    const ecgRate = parseInt(elements.ecgSampleRate.value);
                    const ecgCommand = buildECGCommand(ecgRate);
                    await pmdControl.writeValueWithoutResponse(ecgCommand);
                    console.log(`ECG stream started at ${ecgRate}Hz`);
                }
                
                // Start ACC stream
                if (elements.streamAccCheckbox.checked) {
                    const accRate = parseInt(elements.accSampleRate.value);
                    const accCommand = buildACCCommand(accRate);
                    await pmdControl.writeValueWithoutResponse(accCommand);
                    console.log(`ACC stream started at ${accRate}Hz`);
                }
            } catch (error) {
                console.error('Failed to setup PMD streams:', error);
                throw new Error('Failed to setup ECG/ACC monitoring');
            }
        }
    }

    function buildECGCommand(sampleRate) {
        // PMD control command structure for ECG
        // [Type, Param, 0x00, 0x01, Sample Rate LSB, Sample Rate MSB, Resolution, Channels]
        const rateSettings = {
            130: [0x82, 0x00],
            125: [0x7D, 0x00],
            200: [0xC8, 0x00],
            250: [0xFA, 0x00],
            500: [0xF4, 0x01]
        };
        
        const [lsb, msb] = rateSettings[sampleRate] || rateSettings[130];
        return new Uint8Array([0x02, 0x00, 0x00, 0x01, lsb, msb, 0x01, 0x01, 0x0E, 0x00]);
    }

    function buildACCCommand(sampleRate) {
        // PMD control command structure for ACC
        const rateSettings = {
            25: [0x19, 0x00],
            50: [0x32, 0x00],
            100: [0x64, 0x00],
            200: [0xC8, 0x00]
        };
        
        const [lsb, msb] = rateSettings[sampleRate] || rateSettings[50];
        return new Uint8Array([0x02, 0x02, 0x00, 0x01, lsb, msb, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
    }

    async function setupBatteryMonitoring() {
        try {
            updateStatus('connecting', 'Setting up battery monitoring...');
            const batteryService = await gattServer.getPrimaryService(BATTERY_SERVICE_UUID);
            const batteryCharacteristic = await batteryService.getCharacteristic(BATTERY_LEVEL_UUID);
            
            // Read initial battery level
            const batteryLevel = await batteryCharacteristic.readValue();
            const batteryPercent = batteryLevel.getUint8(0);
            updateBatteryIndicator(batteryPercent);
            
            // Set up notifications for battery level changes (if supported)
            try {
                batteryCharacteristic.addEventListener('characteristicvaluechanged', handleBatteryLevelChange);
                await batteryCharacteristic.startNotifications();
                console.log('Battery level notifications started');
            } catch (notificationError) {
                console.log('Battery notifications not supported, will poll periodically');
                // Start periodic battery level polling every 5 minutes
                setInterval(async () => {
                    try {
                        const level = await batteryCharacteristic.readValue();
                        const percent = level.getUint8(0);
                        updateBatteryIndicator(percent);
                    } catch (error) {
                        console.warn('Failed to read battery level:', error);
                    }
                }, 300000); // 5 minutes
            }
            
            console.log(`Initial battery level: ${batteryPercent}%`);
        } catch (error) {
            console.warn('Battery service not available:', error);
            // Battery service is optional, don't fail the connection
        }
    }

    function handleBatteryLevelChange(event) {
        const batteryLevel = event.target.value.getUint8(0);
        updateBatteryIndicator(batteryLevel);
        console.log(`Battery level updated: ${batteryLevel}%`);
    }

    function updateBatteryIndicator(batteryPercent) {
        elements.batteryPercent.textContent = `${batteryPercent}%`;
        elements.batteryIndicator.classList.remove('hidden');
        
        // Update battery icon based on level
        if (batteryPercent > 75) {
            elements.batteryIcon.textContent = '🔋'; // Full battery
            elements.batteryIndicator.className = elements.batteryIndicator.className.replace(/bg-\w+-\d+/, 'bg-green-100');
        } else if (batteryPercent > 50) {
            elements.batteryIcon.textContent = '🔋'; // Good battery
            elements.batteryIndicator.className = elements.batteryIndicator.className.replace(/bg-\w+-\d+/, 'bg-green-100');
        } else if (batteryPercent > 25) {
            elements.batteryIcon.textContent = '🪫'; // Medium battery
            elements.batteryIndicator.className = elements.batteryIndicator.className.replace(/bg-\w+-\d+/, 'bg-yellow-100');
        } else if (batteryPercent > 10) {
            elements.batteryIcon.textContent = '🪫'; // Low battery
            elements.batteryIndicator.className = elements.batteryIndicator.className.replace(/bg-\w+-\d+/, 'bg-orange-100');
        } else {
            elements.batteryIcon.textContent = '🪫'; // Critical battery
            elements.batteryIndicator.className = elements.batteryIndicator.className.replace(/bg-\w+-\d+/, 'bg-red-100');
            
            // Show low battery warning
            if (batteryPercent <= 10) {
                showModal('Low Battery Warning', 
                    `Polar device battery is critically low (${batteryPercent}%). Please charge your device soon to avoid interruption during data collection.`);
            }
        }
    }

    function onConnected() {
        elements.connectButton.classList.add('hidden');
        elements.disconnectButton.classList.remove('hidden');
        elements.recordButton.disabled = false;
        
        // Disable stream selection
        [elements.streamHrCheckbox, elements.streamEcgCheckbox, elements.streamAccCheckbox].forEach(cb => {
            cb.disabled = true;
        });
        elements.ecgSampleRate.disabled = true;
        elements.accSampleRate.disabled = true;
        
        // Start data quality monitoring
        startDataQualityMonitoring();
        
        // Reset reconnection attempts
        reconnectAttempts = 0;
    }

    function onDisconnected() {
        console.log('Device disconnected');
        
        if (isRecording && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            showModal('Connection Lost', 
                `Attempting to reconnect... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            
            setTimeout(() => attemptReconnection(), 2000);
        } else {
            handleFullDisconnection();
        }
    }

    async function attemptReconnection() {
        try {
            if (bluetoothDevice && !bluetoothDevice.gatt.connected) {
                updateStatus('connecting', 'Reconnecting...');
                gattServer = await bluetoothDevice.gatt.connect();
                await setupDataStreams();
                await setupBatteryMonitoring();
                updateStatus('connected', `Reconnected to ${bluetoothDevice.name}`);
                onConnected();
                showModal('Reconnected', 'Successfully reconnected to the device.');
            }
        } catch (error) {
            console.error('Reconnection failed:', error);
            onDisconnected();
        }
    }

    function handleFullDisconnection() {
        updateStatus('disconnected', 'Disconnected');
        
        elements.connectButton.classList.remove('hidden');
        elements.disconnectButton.classList.add('hidden');
        elements.recordButton.disabled = true;
        elements.addEventButton.disabled = true;
        
        // Hide battery indicator
        elements.batteryIndicator.classList.add('hidden');
        
        // Re-enable stream selection
        [elements.streamHrCheckbox, elements.streamEcgCheckbox, elements.streamAccCheckbox].forEach(cb => {
            cb.disabled = false;
        });
        elements.ecgSampleRate.disabled = false;
        elements.accSampleRate.disabled = false;
        
        // Stop data quality monitoring
        stopDataQualityMonitoring();
        
        if (isRecording) {
            stopRecording();
            showModal('Recording Stopped', 'Device disconnected. Recording has been stopped and data saved.');
        } else {
            showModal('Device Disconnected', 'The Polar device has disconnected.');
        }
        
        bluetoothDevice = null;
        gattServer = null;
    }

    // --- Data Handlers ---
    function handleHRMeasurement(event) {
        const value = event.target.value;
        const { heartRate, rrIntervals } = parseHeartRate(value);
        
        // Update UI
        elements.hrValue.textContent = heartRate;
        flashIndicator('hr-indicator');
        
        if (rrIntervals.length > 0) {
            elements.rrValue.textContent = rrIntervals[rrIntervals.length - 1];
            flashIndicator('rr-indicator');
        }
        
        // Validate data
        if (!validateHRData(heartRate)) {
            console.warn('Invalid HR data:', heartRate);
            return;
        }
        
        // Record data
        if (isRecording) {
            const timestamp = getTimestamp();
            // Use Promise to handle async operation without blocking
            addDataPoint('hrData', { timestamp, heartRate }).catch(console.error);
            
            rrIntervals.forEach(rr => {
                if (validateRRInterval(rr)) {
                    addDataPoint('rrData', { timestamp, rrInterval: rr }).catch(console.error);
                }
            });
        }
        
        updateLastDataTimestamp();
    }

    function handlePMDMeasurement(event) {
        const data = event.target.value;
        const header = parsePMDHeader(data);
        const timestamp = getTimestamp();
        
        switch (header.measurementType) {
            case 0: // ECG
                handleECGData(data, timestamp);
                break;
            case 2: // ACC
                handleACCData(data, timestamp);
                break;
            default:
                console.warn('Unknown PMD measurement type:', header.measurementType);
        }
        
        updateLastDataTimestamp();
    }

    function handleECGData(data, timestamp) {
        const samples = parseECG(data);
        if (samples.length === 0) return;
        
        // Update UI with last sample
        const lastSample = samples[samples.length - 1];
        elements.ecgValue.textContent = lastSample.ecg;
        flashIndicator('ecg-indicator');
        
        // Record data
        if (isRecording) {
            samples.forEach(sample => {
                if (validateECG(sample.ecg)) {
                    addDataPoint('ecgData', { timestamp, ...sample }).catch(console.error);
                }
            });
        }
    }

    function handleACCData(data, timestamp) {
        const samples = parseACC(data);
        if (samples.length === 0) return;
        
        // Update UI with last sample
        const lastSample = samples[samples.length - 1];
        elements.accValue.innerHTML = `${lastSample.x}<br>${lastSample.y}<br>${lastSample.z}`;
        flashIndicator('acc-indicator');
        
        // Record data
        if (isRecording) {
            samples.forEach(sample => {
                addDataPoint('accData', { timestamp, ...sample }).catch(console.error);
            });
        }
    }

    // --- Data Parsers ---
    function parseHeartRate(data) {
        const flags = data.getUint8(0);
        const rate16Bits = (flags & 0x1) !== 0;
        const rrPresent = (flags & 0x10) !== 0;

        let index = 1;
        let heartRate;
        
        if (rate16Bits) {
            heartRate = data.getUint16(index, true);
            index += 2;
        } else {
            heartRate = data.getUint8(index);
            index += 1;
        }

        // Skip energy expended if present
        if (flags & 0x8) {
            index += 2;
        }

        // Parse RR intervals
        const rrIntervals = [];
        if (rrPresent) {
            while (index + 1 < data.byteLength) {
                const rrInterval = data.getUint16(index, true);
                rrIntervals.push(Math.round((rrInterval / 1024) * 1000));
                index += 2;
            }
        }
        
        return { heartRate, rrIntervals };
    }

    function parsePMDHeader(data) {
        return {
            measurementType: data.getUint8(0),
            timestamp: data.getUint32(1, true),
            frameType: data.getUint8(9)
        };
    }

    function parseECG(data) {
        const samples = [];
        let index = 10; // Skip header
        
        while (index + 1 < data.byteLength) {
            // Polar H10 ECG uses 14-bit signed values
            let ecg = data.getUint16(index, true);
            
            // Handle sign extension for 14-bit value
            if (ecg & 0x2000) {
                ecg |= 0xC000;
            }
            
            // Convert to signed 16-bit
            if (ecg >= 0x8000) {
                ecg -= 0x10000;
            }
            
            samples.push({ ecg });
            index += 2;
        }
        
        return samples;
    }

    function parseACC(data) {
        const samples = [];
        let index = 10; // Skip header
        
        while (index + 5 < data.byteLength) {
            const x = data.getInt16(index, true);
            const y = data.getInt16(index + 2, true);
            const z = data.getInt16(index + 4, true);
            samples.push({ x, y, z });
            index += 6;
        }
        
        return samples;
    }

    // --- Data Validation ---
    function validateHRData(heartRate) {
        return heartRate > 0 && heartRate < 250;
    }

    function validateRRInterval(interval) {
        return interval > 200 && interval < 2000; // 30-300 BPM
    }

    function validateECG(value) {
        return value > -32768 && value < 32767;
    }

    // --- Recording Functions ---
    async function startRecording() {
        const participantId = elements.participantIdInput.value.trim();
        if (!participantId) {
            showModal('Input Required', 'Please enter a Participant ID before recording.');
            return;
        }

        // Warn if database is not available
        if (!db || typeof db.put !== 'function') {
            console.warn('Database not available for recording. Data will not be saved to IndexedDB.');
            showModal('Database Warning', 
                'Database is not available. Data will not be saved permanently but recording can continue.');
        }

        isRecording = true;
        recordingStartTime = new Date();
        
        // Create new session
        currentSession = {
            id: `${participantId}_${recordingStartTime.toISOString()}`,
            participantId,
            startTime: recordingStartTime.toISOString(),
            deviceName: bluetoothDevice?.name || 'Unknown',
            selectedStreams: {
                hr: elements.streamHrCheckbox.checked,
                ecg: elements.streamEcgCheckbox.checked,
                acc: elements.streamAccCheckbox.checked
            },
            sampleRates: {
                ecg: elements.streamEcgCheckbox.checked ? parseInt(elements.ecgSampleRate.value) : null,
                acc: elements.streamAccCheckbox.checked ? parseInt(elements.accSampleRate.value) : null
            },
            hrData: [],
            rrData: [],
            ecgData: [],
            accData: [],
            events: []
        };
        
        // Reset buffers and counts
        sessionBuffer = {
            hrData: [],
            rrData: [],
            ecgData: [],
            accData: [],
            events: []
        };
        dataCounts = { hr: 0, rr: 0, ecg: 0, acc: 0 };
        
        // Save initial session
        await saveSession(currentSession);
        
        // Start auto-flush interval (every 10 seconds)
        autoFlushInterval = setInterval(async () => {
            if (isRecording) {
                await flushBufferToDatabase();
            }
        }, 10000);
        
        // Update UI
        elements.recordText.textContent = 'Stop Recording';
        elements.recordButton.classList.remove('bg-green-600', 'hover:bg-green-700');
        elements.recordButton.classList.add('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
        elements.addEventButton.disabled = false;
        elements.participantIdInput.disabled = true;
        elements.exportCsvButton.disabled = true;
        elements.exportJsonButton.disabled = true;
        elements.clearButton.disabled = true;
        
        // Show recording stats
        elements.recordingStats.classList.remove('hidden');
        updateRecordingStats();
        
        
        // Start recording timer
        startRecordingTimer();
        
        // Clear event log
        elements.eventLog.innerHTML = `<p class="text-green-600 font-medium">Recording started at ${recordingStartTime.toLocaleTimeString()}</p>`;
    }

    async function stopRecording() {
        if (!isRecording) return;
        
        try {
            isRecording = false;
            const endTime = new Date();
            
            // Flush remaining buffer
            await flushBufferToDatabase();
            
            // Update session with end time and ensure all data is saved
            if (currentSession) {
                // Get the latest session from DB to include all flushed data (if DB is available)
                let latestSession = currentSession;
                if (db && typeof db.get === 'function') {
                    try {
                        latestSession = await db.get(STORE_NAME, currentSession.id) || currentSession;
                    } catch (error) {
                        console.warn('Failed to get latest session from DB, using current session:', error);
                        latestSession = currentSession;
                    }
                }
                
                // Add any remaining buffered data
                Object.keys(sessionBuffer).forEach(key => {
                    if (sessionBuffer[key].length > 0) {
                        latestSession[key] = [...(latestSession[key] || []), ...sessionBuffer[key]];
                    }
                });
                
                // Update final session details
                latestSession.endTime = endTime.toISOString();
                latestSession.duration = endTime - new Date(latestSession.startTime);
                
                // Save session if database is available
                if (db && typeof db.put === 'function') {
                    await saveSession(latestSession);
                } else {
                    console.warn('Database not available, session data not saved to IndexedDB');
                }
            }
            
            // Update UI
            elements.recordText.textContent = 'Start Recording';
            elements.recordButton.classList.remove('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
            elements.recordButton.classList.add('bg-green-600', 'hover:bg-green-700');
            elements.addEventButton.disabled = true;
            elements.participantIdInput.disabled = false;
            elements.exportCsvButton.disabled = false;
            elements.exportJsonButton.disabled = false;
            elements.clearButton.disabled = false;
            elements.recordTimer.classList.add('hidden');
            
            // Stop recording timer
            stopRecordingTimer();
            
            // Stop auto-flush interval
            if (autoFlushInterval) {
                clearInterval(autoFlushInterval);
                autoFlushInterval = null;
            }
            
            // Add stop message to event log
            const stopMessage = document.createElement('p');
            stopMessage.className = 'text-red-600 font-medium';
            stopMessage.textContent = `Recording stopped at ${endTime.toLocaleTimeString()}`;
            elements.eventLog.appendChild(stopMessage);
            elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
            
            // Show summary
            if (currentSession) {
                showModal('Recording Complete', 
                    `Session saved for participant ${currentSession.participantId}.\n` +
                    `Duration: ${formatDuration(currentSession.duration)}\n` +
                    `Data points: HR: ${dataCounts.hr}, RR: ${dataCounts.rr}, ECG: ${dataCounts.ecg}, ACC: ${dataCounts.acc}`);
            }
            
            currentSession = null;
            await checkStorageQuota();
            
        } catch (error) {
            console.error('Error stopping recording:', error);
            showModal('Stop Recording Error', `Failed to properly stop recording: ${error.message}`);
            
            // Ensure UI is reset even if there was an error
            isRecording = false;
            elements.recordText.textContent = 'Start Recording';
            elements.recordButton.classList.remove('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
            elements.recordButton.classList.add('bg-green-600', 'hover:bg-green-700');
            elements.addEventButton.disabled = true;
            elements.participantIdInput.disabled = false;
            elements.recordTimer.classList.add('hidden');
            
            if (recordingInterval) {
                clearInterval(recordingInterval);
                recordingInterval = null;
            }
            if (autoFlushInterval) {
                clearInterval(autoFlushInterval);
                autoFlushInterval = null;
            }
        }
    }

    async function resumeSession(session) {
        currentSession = session;
        elements.participantIdInput.value = session.participantId;
        
        // Restore counts
        dataCounts = {
            hr: session.hrData?.length || 0,
            rr: session.rrData?.length || 0,
            ecg: session.ecgData?.length || 0,
            acc: session.accData?.length || 0
        };
        
        // Check stream compatibility
        if ((session.selectedStreams.hr && !elements.streamHrCheckbox.checked) ||
            (session.selectedStreams.ecg && !elements.streamEcgCheckbox.checked) ||
            (session.selectedStreams.acc && !elements.streamAccCheckbox.checked)) {
            showModal('Stream Mismatch', 
                'The selected data streams do not match the previous session. Please select the same streams.');
            currentSession = null;
            return;
        }
        
        // Resume recording
        isRecording = true;
        recordingStartTime = new Date(session.startTime);
        
        // Update UI
        elements.recordText.textContent = 'Stop Recording';
        elements.recordButton.classList.remove('bg-green-600', 'hover:bg-green-700');
        elements.recordButton.classList.add('bg-red-600', 'hover:bg-red-700', 'recording-pulse');
        elements.addEventButton.disabled = false;
        elements.participantIdInput.disabled = true;
        elements.recordingStats.classList.remove('hidden');
        
        startRecordingTimer();
        updateRecordingStats();
        
        // Clear event log and add resume message
        elements.eventLog.innerHTML = `<p class="text-blue-600 font-medium">Resumed recording for ${session.participantId}</p>`;
        
        // Restore existing events if any
        if (session.events && session.events.length > 0) {
            session.events.forEach(eventData => {
                // Add ID if not present (for backward compatibility)
                if (!eventData.id) {
                    eventData.id = eventData.timestamp;
                }
                const eventTime = new Date(eventData.timestamp).toLocaleTimeString();
                const eventEntry = createEventElement(eventData, eventTime, eventData.label);
                elements.eventLog.appendChild(eventEntry);
            });
            elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
        }
    }

    // --- Event Management ---
    function addEvent() {
        const label = elements.eventLabelInput.value.trim() || 'Marked Event';
        if (!isRecording || !currentSession) return;
        
        const timestamp = getTimestamp();
        const eventId = Date.now() + Math.random(); // Unique ID for this event
        const eventData = { timestamp, label, id: eventId };
        
        // Add to buffer
        sessionBuffer.events.push(eventData);
        
        // Update UI
        const eventEntry = createEventElement(eventData, new Date().toLocaleTimeString(), label);
        elements.eventLog.appendChild(eventEntry);
        elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
        
        // Clear input
        elements.eventLabelInput.value = '';
        elements.eventLabelInput.focus();
        
        // Flush if needed
        if (sessionBuffer.events.length >= BATCH_SIZE) {
            flushBufferToDatabase();
        }
    }

    function createEventElement(eventData, timeString, label) {
        const eventEntry = document.createElement('div');
        eventEntry.className = 'event-entry group flex items-center justify-between p-2 rounded hover:bg-gray-50 transition-colors';
        eventEntry.setAttribute('data-event-id', eventData.id || eventData.timestamp); // Use ID or fallback to timestamp
        
        eventEntry.innerHTML = `
            <div class="flex-grow">
                <span class="font-semibold text-purple-600">${timeString}</span>
                <span class="event-label text-gray-700 ml-2">${label}</span>
            </div>
            <div class="event-actions flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="edit-event-btn text-gray-400 hover:text-blue-600 p-1 rounded" title="Edit event">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                    </svg>
                </button>
                <button class="delete-event-btn text-gray-400 hover:text-red-600 p-1 rounded" title="Delete event">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                    </svg>
                </button>
            </div>
        `;
        
        return eventEntry;
    }

    function editEvent(eventData, eventEntry) {
        const eventLabel = eventEntry.querySelector('.event-label');
        const eventActions = eventEntry.querySelector('.event-actions');
        const currentLabel = eventLabel.textContent;
        
        // Store the timestamp text before replacing content
        const timestampElement = eventEntry.querySelector('.font-semibold');
        const timestampText = timestampElement.textContent;
        
        // Create editing interface
        const editingDiv = document.createElement('div');
        editingDiv.className = 'flex items-center gap-2 flex-grow';
        editingDiv.innerHTML = `
            <input type="text" class="edit-input flex-grow px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" value="${currentLabel}">
            <button class="save-event-btn text-green-600 hover:text-green-700 p-1 rounded" title="Save changes">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
            </button>
            <button class="cancel-event-btn text-gray-600 hover:text-gray-700 p-1 rounded" title="Cancel editing">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </button>
        `;
        
        // Replace the content
        const originalContent = eventEntry.querySelector('div:first-child');
        eventEntry.replaceChild(editingDiv, originalContent);
        eventActions.style.display = 'none';
        
        // Focus the input
        const editInput = editingDiv.querySelector('.edit-input');
        editInput.focus();
        editInput.select();
        
        // Save function
        const saveEdit = () => {
            const newLabel = editInput.value.trim();
            if (newLabel && newLabel !== currentLabel) {
                // Update the data
                eventData.label = newLabel;
                
                // Update the UI
                const newContent = document.createElement('div');
                newContent.className = 'flex-grow';
                newContent.innerHTML = `
                    <span class="font-semibold text-purple-600">${timestampText}</span>
                    <span class="event-label text-gray-700 ml-2">${newLabel}</span>
                `;
                eventEntry.replaceChild(newContent, editingDiv);
                eventActions.style.display = '';
            } else {
                cancelEdit();
            }
        };
        
        // Cancel function
        const cancelEdit = () => {
            const newContent = document.createElement('div');
            newContent.className = 'flex-grow';
            newContent.innerHTML = `
                <span class="font-semibold text-purple-600">${timestampText}</span>
                <span class="event-label text-gray-700 ml-2">${currentLabel}</span>
            `;
            eventEntry.replaceChild(newContent, editingDiv);
            eventActions.style.display = '';
        };
        
        // Event listeners
        editingDiv.querySelector('.save-event-btn').addEventListener('click', saveEdit);
        editingDiv.querySelector('.cancel-event-btn').addEventListener('click', cancelEdit);
        editInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveEdit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
            }
        });
    }

    function deleteEvent(eventData, eventEntry) {
        const eventLabel = eventData.label;
        const eventTime = new Date(eventData.timestamp).toLocaleTimeString();
        
        showModal('Delete Event', 
            `Are you sure you want to delete this event?\n\nTime: ${eventTime}\nLabel: "${eventLabel}"\n\nThis action cannot be undone.`,
            true, 
            () => {
                // Remove from data array
                const eventIndex = sessionBuffer.events.findIndex(e => e.id === eventData.id || e.timestamp === eventData.timestamp);
                if (eventIndex !== -1) {
                    sessionBuffer.events.splice(eventIndex, 1);
                }
                
                // Remove from UI
                eventEntry.remove();
            }
        );
    }


    // --- Export Functions ---
    async function exportToCSV() {
        const sessions = await getAllSessions();
        if (sessions.length === 0) {
            showModal('No Data', 'There is no data to export.');
            return;
        }
        
        let csvContent = 'ParticipantID,SessionStartTime,SessionEndTime,DeviceName,DataType,Timestamp,Value1,Value2,Value3,EventLabel\n';
        
        sessions.forEach(session => {
            const sessionInfo = `${session.participantId},${session.startTime},${session.endTime || 'ongoing'},${session.deviceName}`;
            
            // HR data
            session.hrData?.forEach(row => {
                csvContent += `${sessionInfo},HR,${row.timestamp},${row.heartRate},,,\n`;
            });
            
            // RR data
            session.rrData?.forEach(row => {
                csvContent += `${sessionInfo},RR,${row.timestamp},${row.rrInterval},,,\n`;
            });
            
            // ECG data
            session.ecgData?.forEach(row => {
                csvContent += `${sessionInfo},ECG,${row.timestamp},${row.ecg},,,\n`;
            });
            
            // ACC data
            session.accData?.forEach(row => {
                csvContent += `${sessionInfo},ACC,${row.timestamp},${row.x},${row.y},${row.z},\n`;
            });
            
            // Events
            session.events?.forEach(row => {
                csvContent += `${sessionInfo},Event,${row.timestamp},,,,${row.label}\n`;
            });
        });
        
        downloadFile(csvContent, `polar_export_${new Date().toISOString().split('T')[0]}.csv`, 'text/csv');
        showModal('Export Complete', `Exported ${sessions.length} session(s) to CSV.`);
    }

    async function exportToJSON() {
        const sessions = await getAllSessions();
        if (sessions.length === 0) {
            showModal('No Data', 'There is no data to export.');
            return;
        }
        
        const exportData = {
            exportDate: new Date().toISOString(),
            version: '2.0',
            sessions: sessions.map(session => ({
                ...session,
                summary: {
                    duration: session.duration || 
                        (session.endTime ? new Date(session.endTime) - new Date(session.startTime) : null),
                    dataCounts: {
                        hr: session.hrData?.length || 0,
                        rr: session.rrData?.length || 0,
                        ecg: session.ecgData?.length || 0,
                        acc: session.accData?.length || 0,
                        events: session.events?.length || 0
                    }
                }
            }))
        };
        
        const jsonContent = JSON.stringify(exportData, null, 2);
        downloadFile(jsonContent, `polar_export_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
        showModal('Export Complete', `Exported ${sessions.length} session(s) to JSON.`);
    }

    function downloadFile(content, fileName, mimeType) {
        const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', fileName);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // --- UI Helper Functions ---
    function updateSampleRateControls() {
        const showControls = elements.streamEcgCheckbox.checked || elements.streamAccCheckbox.checked;
        
        if (showControls) {
            elements.sampleRateControls.classList.remove('hidden');
            elements.ecgRateControl.classList.toggle('hidden', !elements.streamEcgCheckbox.checked);
            elements.accRateControl.classList.toggle('hidden', !elements.streamAccCheckbox.checked);
        } else {
            elements.sampleRateControls.classList.add('hidden');
        }
    }

    function flashIndicator(indicatorId) {
        const indicator = document.getElementById(indicatorId);
        if (indicator) {
            indicator.classList.add('active');
            setTimeout(() => indicator.classList.remove('active'), 200);
        }
    }

    function updateRecordingStats() {
        elements.hrCount.textContent = dataCounts.hr;
        elements.rrCount.textContent = dataCounts.rr;
        elements.ecgCount.textContent = dataCounts.ecg;
        elements.accCount.textContent = dataCounts.acc;
    }

    function startRecordingTimer() {
        recordingInterval = setInterval(() => {
            const elapsed = Date.now() - recordingStartTime;
            elements.recordTimer.textContent = formatDuration(elapsed);
            elements.recordTimer.classList.remove('hidden');
        }, 1000);
    }

    function stopRecordingTimer() {
        if (recordingInterval) {
            clearInterval(recordingInterval);
            recordingInterval = null;
        }
    }

    function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) {
            return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
        }
    }

    function getTimestamp() {
        return new Date().toISOString();
    }

    function updateLastDataTimestamp() {
        lastDataTimestamp = Date.now();
    }

    // --- Data Quality Monitoring ---
    function startDataQualityMonitoring() {
        dataQualityInterval = setInterval(checkDataQuality, DATA_QUALITY_CHECK_INTERVAL);
    }

    function stopDataQualityMonitoring() {
        if (dataQualityInterval) {
            clearInterval(dataQualityInterval);
            dataQualityInterval = null;
        }
        elements.dataQuality.classList.add('hidden');
    }

    function checkDataQuality() {
        if (!isRecording) return;
        
        const now = Date.now();
        const timeSinceLastData = now - lastDataTimestamp;
        
        if (timeSinceLastData > DATA_QUALITY_CHECK_INTERVAL) {
            dataGaps++;
            elements.dataQuality.classList.remove('hidden');
            elements.qualityStatus.textContent = 'Poor - Data Gap Detected';
            elements.gapCount.textContent = dataGaps;
        } else {
            elements.qualityStatus.textContent = 'Good';
        }
    }

    // --- Modal Functions ---
    function showModal(title, message, showConfirm = false, confirmCallback = null) {
        elements.modalTitle.textContent = title;
        elements.modalMessage.textContent = message;
        elements.modalButtons.innerHTML = '';

        if (showConfirm) {
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Confirm';
            confirmBtn.className = 'bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 transition-colors';
            confirmBtn.onclick = () => {
                if (confirmCallback) confirmCallback();
                hideModal();
            };
            elements.modalButtons.appendChild(confirmBtn);

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.className = 'bg-gray-200 text-gray-800 font-bold py-2 px-6 rounded-lg hover:bg-gray-300 transition-colors';
            cancelBtn.onclick = hideModal;
            elements.modalButtons.appendChild(cancelBtn);
        } else {
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'bg-blue-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-blue-700 transition-colors';
            closeBtn.onclick = hideModal;
            elements.modalButtons.appendChild(closeBtn);
        }

        elements.modal.classList.remove('hidden');
    }

    function hideModal() {
        elements.modal.classList.add('hidden');
    }

    // --- Event Listeners ---
    elements.connectButton.addEventListener('click', connectToDevice);
    
    elements.disconnectButton.addEventListener('click', () => {
        if (bluetoothDevice && bluetoothDevice.gatt.connected) {
            bluetoothDevice.gatt.disconnect();
        }
    });

    elements.recordButton.addEventListener('click', () => {
        if (isRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    elements.addEventButton.addEventListener('click', addEvent);

    elements.eventLabelInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter' && !elements.addEventButton.disabled) {
            addEvent();
        }
    });

    elements.exportCsvButton.addEventListener('click', exportToCSV);
    elements.exportJsonButton.addEventListener('click', exportToJSON);

    elements.clearButton.addEventListener('click', () => {
        showModal('Confirm Deletion', 
            'Are you sure you want to delete all stored data? This action cannot be undone.',
            true, 
            async () => {
                await clearAllData();
                elements.exportCsvButton.disabled = true;
                elements.exportJsonButton.disabled = true;
                elements.clearButton.disabled = true;
                showModal('Data Cleared', 'All session data has been successfully deleted.');
            }
        );
    });

    // Stream checkbox listeners
    [elements.streamHrCheckbox, elements.streamEcgCheckbox, elements.streamAccCheckbox].forEach(checkbox => {
        checkbox.addEventListener('change', updateSampleRateControls);
    });

    // Event log delegation for edit/delete buttons
    elements.eventLog.addEventListener('click', (e) => {
        const eventEntry = e.target.closest('.event-entry');
        if (!eventEntry) return;
        
        const eventId = eventEntry.getAttribute('data-event-id');
        if (!eventId) return;
        
        // Find the event data by ID or timestamp
        const eventData = sessionBuffer.events.find(event => 
            (event.id && event.id.toString() === eventId) || 
            event.timestamp.toString() === eventId
        );
        
        if (!eventData) return;
        
        if (e.target.closest('.edit-event-btn')) {
            editEvent(eventData, eventEntry);
        } else if (e.target.closest('.delete-event-btn')) {
            deleteEvent(eventData, eventEntry);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            switch(e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    if (!elements.recordButton.disabled) {
                        elements.recordButton.click();
                    }
                    break;
                case 'e':
                    e.preventDefault();
                    if (!elements.exportCsvButton.disabled) {
                        elements.exportCsvButton.click();
                    }
                    break;
            }
        }
    });

    // Prevent accidental page closure during recording
    window.addEventListener('beforeunload', (e) => {
        if (isRecording) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    // Handle visibility change to detect when tab becomes inactive
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && isRecording) {
            console.warn('Tab became inactive during recording');
        }
    });

    // --- Initialization ---
    (async function init() {
        console.log('Initializing Polar Data Collector...');
        
        // Check browser compatibility
        if (!navigator.bluetooth) {
            showModal('Browser Compatibility', 
                'Web Bluetooth is not supported in this browser. Please use Chrome or Edge on desktop/Android, or Bluefy on iOS.');
        }
        
        // Initialize database
        await initDB();
        
        // Set initial UI state
        updateSampleRateControls();
        
        console.log('Initialization complete');
    })();
});
