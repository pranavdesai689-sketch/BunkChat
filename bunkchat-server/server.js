const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// -------------------------------------------------
// GLOBAL IN-MEMORY STATE
// -------------------------------------------------
const users = new Map();
// ws -> { name: string, pending: Map<senderName, [{from,message,timestamp}]> }
const groups = new Map(); // Key: groupCode, Value: { admin: String, members: Set<String>, locked: Boolean }

console.log('BunkChat Server running on port 3000');

// -------------------------------------------------
// HELPER FUNCTIONS
// -------------------------------------------------
function broadcastOnlineUsers() {
    const onlineList = Array.from(users.values()).map(u => u.name);
    const message = JSON.stringify({
        type: 'online_users',
        users: onlineList
    });

    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function getSocketByName(name) {
    for (const [ws, userData] of users.entries()) {
        if (userData.name === name) return ws;
    }
    return null;
}

function handleDisconnect(ws) {
    const user = users.get(ws);
    if (!user) return;

    const name = user.name;
    users.delete(ws);

    // Remove from all groups
    for (const [code, group] of groups.entries()) {
        if (group.members.has(name)) {
            group.members.delete(name);

            // Notify group
            broadcastToGroup(code, {
                type: 'group_notification',
                code: code,
                message: `${name} left the group.`
            });

            // If empty, delete group (Optional, but good cleanup)
            if (group.members.size === 0) {
                groups.delete(code);
            }
        }
    }

    broadcastOnlineUsers();
    console.log(`${name} disconnected.`);
}

function broadcastToGroup(code, data) {
    const group = groups.get(code);
    if (!group) return;

    const msg = JSON.stringify(data);

    group.members.forEach(memberName => {
        const memberWs = getSocketByName(memberName);
        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
            memberWs.send(msg);
        }
    });
}

// -------------------------------------------------
// CONNECTION HANDLER
// -------------------------------------------------
wss.on('connection', (ws) => {
    console.log('New connection...');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleEvent(ws, data);
        } catch (e) {
            console.error('Invalid JSON:', e);
        }
    });

    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
});

// -------------------------------------------------
// EVENT ROUTING
// -------------------------------------------------
function handleEvent(ws, data) {
    switch (data.type) {
        case 'join':
            handleJoin(ws, data.name);
            break;
        case 'personal_message':
            handlePersonalMessage(ws, data.to, data.message, data.replyTo);
            break;
        case 'typing':
            handleTyping(ws, data.to);
            break;
        case 'create_group':
            handleCreateGroup(ws, data.code);
            break;
        case 'join_group':
            handleJoinGroup(ws, data.code);
            break;
        case 'group_message':
            handleGroupMessage(ws, data.code, data.message, data.replyTo);
            break;
        case 'end_group':
            handleEndGroup(ws, data.code);
            break;
        case 'toggle_lock':
            handleToggleLock(ws, data.code);
            break;
        case 'leave_group':
            handleLeaveGroup(ws, data.code);
            break;
        default:
            break;
    }
}

// -------------------------------------------------
// HANDLERS
// -------------------------------------------------
function handleJoin(ws, requestedName) {
    if (!requestedName) return;

    let finalName = requestedName.trim();
    let counter = 2;

    // Check duplicates
    const isTaken = (n) => {
        for (const u of users.values()) {
            if (u.name === n) return true;
        }
        return false;
    };

    while (isTaken(finalName)) {
        finalName = `${requestedName} (${counter})`;
        counter++;
    }

    users.set(ws, { name: finalName, pending: new Map() });

    // Confirm join to user
    ws.send(JSON.stringify({
        type: 'login_success',
        username: finalName
    }));

    const user = users.get(ws);
    if (user && user.pending.size > 0) {
        for (const msgs of user.pending.values()) {
            msgs.forEach(m => ws.send(JSON.stringify(m)));
        }
        user.pending.clear();
    }

    broadcastOnlineUsers();
    console.log(`${finalName} joined.`);
}

function handlePersonalMessage(ws, targetName, content, replyTo = null) {
    const sender = users.get(ws);
    if (!sender) return;

    const payload = {
        type: 'personal_message',
        from: sender.name,
        message: content,
        replyTo: replyTo,
        timestamp: Date.now()
    };

    const targetWs = getSocketByName(targetName);

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(payload));
    } else {
        for (const user of users.values()) {
            if (user.name === targetName) {
                if (!user.pending.has(sender.name)) {
                    user.pending.set(sender.name, []);
                }
                user.pending.get(sender.name).push(payload);
            }
        }
    }
}

// ... (skipping unchanged code)

function handleGroupMessage(ws, code, content, replyTo = null) {
    const sender = users.get(ws);
    if (!sender) return;

    const group = groups.get(code);
    if (!group || !group.members.has(sender.name)) return;

    const msg = JSON.stringify({
        type: 'group_message',
        code: code,
        from: sender.name,
        message: content,
        replyTo: replyTo,
        isAdmin: group.admin === sender.name,
        timestamp: Date.now()
    });

    // Broadcast to all members including sender (for confirmation)
    group.members.forEach(memberName => {
        const memberWs = getSocketByName(memberName);
        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
            memberWs.send(msg);
        }
    });
}

function handleEndGroup(ws, code) {
    const sender = users.get(ws);
    if (!sender) return;

    const group = groups.get(code);
    if (!group) return;

    if (group.admin !== sender.name) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Only the admin can end the group.'
        }));
        return;
    }

    // Notify all
    broadcastToGroup(code, {
        type: 'group_ended',
        code: code,
        message: 'The admin has ended the group chat.'
    });

    groups.delete(code);
    console.log(`Group ${code} ended.`);
}

function handleToggleLock(ws, code) {
    console.log(`[ToggleLock] Request for code: ${code}`);
    const sender = users.get(ws);
    if (!sender) {
        console.log(`[ToggleLock] Sender not found`);
        return;
    }

    const group = groups.get(code);
    if (!group) {
        console.log(`[ToggleLock] Group not found`);
        return;
    }

    if (group.admin !== sender.name) {
        console.log(`[ToggleLock] Denied. Sender ${sender.name} is not admin ${group.admin}`);
        return;
    }

    group.locked = !group.locked;
    console.log(`[ToggleLock] Group ${code} locked status: ${group.locked}`);

    broadcastToGroup(code, {
        type: 'group_lock_update',
        code,
        locked: group.locked
    });
}

function handleLeaveGroup(ws, code) {
    const sender = users.get(ws);
    if (!sender) return;

    const group = groups.get(code);
    if (!group) return;

    group.members.delete(sender.name);

    ws.send(JSON.stringify({
        type: 'left_group',
        code
    }));

    broadcastToGroup(code, {
        type: 'group_member_joined',
        code,
        admin: group.admin,
        members: Array.from(group.members)
    });

    if (group.members.size === 0) {
        groups.delete(code);
    }
}
