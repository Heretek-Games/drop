#![feature(nonpoison_mutex)]
#![feature(sync_nonpoison)]
#![feature(extend_one)]
#![feature(vec_try_remove)]

use std::{
    ops::Deref,
    sync::{Arc, OnceLock, nonpoison::Mutex},
};

use tauri::AppHandle;

use crate::process_manager::ProcessManager;

pub static PROCESS_MANAGER: ProcessManagerWrapper = ProcessManagerWrapper::new();

#[cfg(target_os = "linux")]
pub mod compat;
pub mod error;
pub mod format;
pub mod gse_interceptor;
pub mod interceptor;
mod parser;
pub mod process_handlers;
pub mod process_manager;

pub struct ProcessManagerWrapper(OnceLock<Mutex<ProcessManager<'static>>>);
impl ProcessManagerWrapper {
    const fn new() -> Self {
        ProcessManagerWrapper(OnceLock::new())
    }
    pub fn init(app_handle: AppHandle) {
        PROCESS_MANAGER
            .0
            .set(Mutex::new(ProcessManager::new(app_handle)))
            .unwrap_or_else(|_| panic!("Failed to initialise Process Manager")); // Using panic! here because we can't implement Debug
    }
    pub fn register_interceptor(&self, interceptor: Arc<dyn crate::interceptor::LaunchInterceptor>) {
        self.lock().register_interceptor(interceptor);
    }
    pub fn register_global_interceptor(interceptor: Arc<dyn crate::interceptor::LaunchInterceptor>) {
        PROCESS_MANAGER.register_interceptor(interceptor);
    }
    pub fn unregister_interceptor(&self, id: &str) {
        self.lock().unregister_interceptor(id);
    }
}
impl Deref for ProcessManagerWrapper {
    type Target = Mutex<ProcessManager<'static>>;

    fn deref(&self) -> &Self::Target {
        match self.0.get() {
            Some(process_manager) => process_manager,
            None => unreachable!("Download manager should always be initialised"),
        }
    }
}
