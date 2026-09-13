use std::str::FromStr;

use dialoguer::{Input, theme::ColorfulTheme};

#[macro_export]
macro_rules! interactive_variable {
    ($value:ident, $var:ident, $prompt:expr) => {
        let $var = if let Some($var) = $value.$var {
            $var
        } else {
            $crate::commands::connect::interactive::query_variable($prompt).unwrap()
        };
    };
}
pub fn query_variable<T: Clone + FromStr + ToString>(prompt: impl ToString) -> dialoguer::Result<T>
where
    <T as FromStr>::Err: ToString,
{
    Input::with_theme(&ColorfulTheme::default())
        .with_prompt(prompt.to_string())
        .interact_text()
}
