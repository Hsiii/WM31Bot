import AppKit
import CoreGraphics
import Foundation

func isSessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return true
    }

    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
}

func emit(_ state: String) {
    print(state)
    fflush(stdout)
}

var lastState: String?

func emitIfChanged(_ state: String) {
    guard state != lastState else {
        return
    }

    lastState = state
    emit(state)
}

func reconcileSession() {
    emitIfChanged(isSessionLocked() ? "locked" : "unlocked")
}

let distributedCenter = DistributedNotificationCenter.default()
let workspaceCenter = NSWorkspace.shared.notificationCenter

distributedCenter.addObserver(
    forName: Notification.Name("com.apple.screenIsLocked"),
    object: nil,
    queue: .main
) { _ in
    emitIfChanged("locked")
}

distributedCenter.addObserver(
    forName: Notification.Name("com.apple.screenIsUnlocked"),
    object: nil,
    queue: .main
) { _ in
    reconcileSession()
}

workspaceCenter.addObserver(
    forName: NSWorkspace.willSleepNotification,
    object: nil,
    queue: .main
) { _ in
    emitIfChanged("locked")
}

workspaceCenter.addObserver(
    forName: NSWorkspace.didWakeNotification,
    object: nil,
    queue: .main
) { _ in
    reconcileSession()
}

// Background LaunchAgents can miss distributed unlock notifications.
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    reconcileSession()
}

reconcileSession()
RunLoop.main.run()
