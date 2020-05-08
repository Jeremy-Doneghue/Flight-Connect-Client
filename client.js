// Jeremy Doneghue
// iSim
// Created on: 09-05-2019

class AppConnection {

    constructor(ip, metadata, onReady) {

        const connectionConfigs = {
            XPLANE_PORT: 9002,
            FC_PORT: 9003,
        }
        let portToTry = connectionConfigs.FC_PORT;

        if (ip === 'auto') {
            if (window.location.protocol === "file:") {
                ip = 'localhost';
            }
            else if (window.location.protocol === "http:" || window.location.protocol === "https:") {
                ip = window.location.hostname;
            }
        }

        const getURL = (port) => {
            return `ws://${ip}:${port}`;
        }

        let _socket = new WebSocket(getURL(portToTry));
        this.ready = false;
        this.firstResponse = true;
        this.identifier = null;

        this.state = {};

        // The array of subscribers
        this.globalDatarefs = {}; // Obj containing unique datarefs that have been subscribed to
        this.keySets = [];
        this.timeOfLastMessage = new Date().getTime();
        this.timeSinceLastMessage = 0;

        // Event callbacks
        this.onTimeoutCallback = null;
        this.onLoadingStateChanges = null;

        // Once time dataref request callbacks
        this.drRequestCallbacks = [];

        // Command callbacks
        this.commandCallbacks = {};

        this.xplaneProbablyIsLoading = true;

        const addListeners = (sock) => {

            sock.onopen = () => {
                this.ready = true;
            };
            sock.onmessage = (event) => {

                const now = new Date().getTime();
                this.timeOfLastMessage = now;
                const res = JSON.parse(event.data);

                if (this.identifier === null) {
                    if (res.type === "LOG") {
                        console.warn(res.value);
                        if (res.value === "Subscription limit for free trial version exceeded") {
                            const elem = document.createElement('div');
                            elem.innerHTML = "Subscription limit for free trial version exceeded";
                            elem.setAttribute('style', 'color: red; font-family: sans-serif;');
                            document.body.appendChild(elem);
                        }
                        return;
                    }
                    else if (res.type === "ID") {
                        this.identifier = res.value;
                        console.log("identifier: " + res.value);
                        this._sendIdentity(metadata)
                        onReady(this);
                        return;
                    }
                }
                else {
                    switch (res.type) {
                    case "RES": {
                        // For each subscriber, check whether any of the requested datarefs have changed
                        // If they have, call the function
                        
                        var subscriber;
                        var changes = false;
                        for (var i = 0; i < this.keySets.length; i++) {
                            subscriber = this.keySets[i];

                            // Check for Ch-ch-ch-ch-changes
                            changes = false;
                            for (let key of subscriber.datarefs) {
                                if (res.value[key] !== this.state[key] || res.value[key] !== undefined) {
                                    changes = true;
                                    break;
                                }
                            }
                            if (changes) {
                                // If the minimum time has elapsed
                                if (subscriber.minDeltaTime !== 0) { 
                                    if (now - subscriber.timeOfLast < subscriber.minDeltaTime * 1000) {
                                        break;
                                    }
                                }

                                const results = [];
                                for (const key of subscriber.datarefs) {
                                    let val = res.value[key] || this.state[key];
                                    if (val === undefined) {
                                        val = 0;
                                    }
                                    results.push(val);
                                }
                                // Call it with the values
                                subscriber.timeOfLast = now;
                                subscriber.function.apply(subscriber.this, results);
                            }
                        }
                        this.state = Object.assign(this.state, res.value);
                        break;
                    }
                    case "COMMAND": {
                        Object.values(this.commandCallbacks[res.value]).forEach(f => f());
                        break;
                    }
                    case "ONCE": {
                        this.drRequestCallbacks.shift()(res.value);
                        break;
                    }
                    case "LOG": {
                        console.warn(res.value);
                        break;
                    }
                    case "CHNGCONN": {
                        const newPort = res.value.port;
                        const newHost = res.value.host;
                        ip = newHost;

                        if (typeof newPort !== 'undefined' && newPort != null &&
                            typeof newHost !== 'undefined' && newHost != null)
                        {
                            console.info(`The instrument is now connecting to ws://${newHost}:${newPort}`);
                            const newSock = new WebSocket(`ws://${newHost}:${newPort}`);
                            addListeners(newSock);
                            this.socket.close();
                            this.identifier = null;
                            this.commandCallbacks = {};
                            this.socket = newSock;
                        }
                        break;
                    }
                    default:
                        console.warn("Problem with response")
                        break;
                    }
                }
            };
            sock.onerror = () => {
                console.warn('Unspecified error with socket');
                this.onTimeoutCallback && this.onTimeoutCallback();
            };
            sock.onclose = (event) => {
                switch (event.code) {
                case 1006:
                    setTimeout(() => {
                        console.log('Reconnecting...');
                        portToTry = (portToTry === connectionConfigs.FC_PORT)
                            ? connectionConfigs.XPLANE_PORT : connectionConfigs.FC_PORT;

                        _socket = new WebSocket(getURL(portToTry));
                        this.firstResponse = true;
                        this.identifier = null;
                        addListeners(_socket);
                        this.socket = _socket;
                    }, 5000);
                    break;
                default:
                    break;
                }
            };
        }

        addListeners(_socket);
        this.socket = _socket;
    }

    setDataref(dataref, type, value) {
        this.sendMessage({
            id: this.identifier,
            command: "SET",
            dataref: dataref,
	        data: String(value),
	        type: type,
        });
    }

    getDatarefs(datarefs, callback) {
        this.drRequestCallbacks.push(callback);
        this.sendMessage({
            data: datarefs,
            command: "GET_ONCE",
            id: this.identifier,
        });
    }

    setArrayDataref(dataref, type, array, offset) {

        if (type==="INT") { type = "INT_ARRAY"; }
        if (type==="FLOAT") { type = "FLOAT_ARRAY"; }
        if (type !== "FLOAT_ARRAY" && type !== "INT_ARRAY") { throw "Type must be INT_ARRAY or FLOAT_ARRAY" }

        this.sendMessage({
            id: this.identifier,
            command: "ASET",
            dataref: dataref,
            type: type,
            data: array,
            offset: offset
        });
    }

    on(event, call) {
        if (event === 'loadingStateChanges') {
            this.onLoadingStateChanges = call;
        }
        else if (event === 'connectionTimeout') {
            this.onTimeoutCallback = call;
        }
    }

    registerCommandCallback(command, callback) {

        // Prepare to receive
        const cbid = this._uuidv4();
        if (this.commandCallbacks.hasOwnProperty(command)) {
            this.commandCallbacks[command][cbid] = callback;
        } else {
            this.commandCallbacks[command] = { [cbid]: callback };  
        }

        // Send subscribe message
        this.sendMessage({
            id: this.identifier,
            command: "REGISTER_CMD_CALLBACK",
            data: command,
        });

        // Return the id used to unsubscribe
        return cbid;
    }

    removeCommandCallback(command, cbid) {
        delete this.commandCallbacks[command][cbid];
    }

    moveToAirport(icao) {
        this.sendMessage({
            id: this.identifier,
            command: "REPOSITION",
            data: icao,
        });
    }

    moveToPosition(lat, lon, hdg, alt, speed, fast) {
        this.sendMessage({
            id: this.identifier,
            command: "REPOSITION",
            data: { lat, lon, hdg, alt, speed, fast }
        });
    }

    runCommand(name) {
        this.sendMessage({
            id: this.identifier,
            command: "RUN_COMMAND",
            data: name,
            type: 0,
        });
    }

    commandOnce(name) {
        this.runCommand(name);
    }

    commandBegin(name) {
        this.sendMessage({
            id: this.identifier,
            command: "RUN_COMMAND",
            data: name,
            type: 1,
        });
    }

    commandEnd(name) {
        this.sendMessage({
            id: this.identifier,
            command: "RUN_COMMAND",
            data: name,
            type: 2,
        });
    }

    commandForDuration(name, durationMs) {
        this.commandBegin(name);
        setTimeout(() => {
            this.commandEnd(name);
        }, durationMs);
    }

    // From https://stackoverflow.com/a/2117523
    _uuidv4() {
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
            (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
        );
    }

    datarefSubscribeWithPrecision({ func, minDeltaTime, precision, datarefs}) {
        if (typeof minDeltaTime === 'undefined')
            minDeltaTime = 0;

        const uuid = this._uuidv4()
        let res = {
            minDeltaTime,
            timeOfLast: new Date().getTime(),
            datarefs: datarefs,
            name: uuid,
            "function": func,
            "this": window,
        };
        this.keySets.push(res);

        // Initialise dataref state to zero
        for (let dataref of datarefs) {
            this.state[dataref] = 0;
        }

        // Send
        this.sendMessage({
            id: this.identifier,
            command: "SUBSCRIBE",
            precision: precision || 0,
            data: datarefs,
        });
    }

    datarefSubscribe(func, minDeltaTime, ...datarefs) {

        if (typeof minDeltaTime === 'undefined')
            minDeltaTime = 0;

        const uuid = this._uuidv4()
        let res = {
            minDeltaTime,
            timeOfLast: new Date().getTime(),
            datarefs: datarefs,
            name: uuid,
            "function": func,
            "this": window,
        };
        this.keySets.push(res);

        // Send
        const message = {
            id: this.identifier,
            command: "SUBSCRIBE",
            precision: 0.01,
            data: [...datarefs],
        }
        this.sendMessage(message);
    }

    sendMessage(objectToSerialize) {
        console.log(objectToSerialize)
        if (!objectToSerialize.hasOwnProperty('id')) {
            throw new Error("Message must contain connection identifier property: id");
        }
        try {
            this.socket.send(JSON.stringify(objectToSerialize));
        } catch {
            console.warn("Problem with socket, reloading page in 5s");
            window.setTimeout(window.location.reload.bind(window.location), 5000);
        }
    }

    _sendIdentity(metadata) {
        const message = {
            id: this.identifier,
            command: "IDENTIFY",
            data: metadata,
        }
        this.sendMessage(message);
    }
}

// export default AppConnection;